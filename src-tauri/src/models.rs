use serde::{Deserialize, Serialize};

// 规范化后的远程模型信息
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RemoteModel {
    pub id: String,
    pub label: Option<String>,
}

#[derive(Deserialize)]
struct OpenAIModelsResponse {
    #[serde(default)]
    data: Vec<OpenAIModel>,
}

#[derive(Deserialize)]
struct OpenAIModel {
    id: String,
}

#[derive(Deserialize)]
struct GeminiModelsResponse {
    #[serde(default)]
    models: Vec<GeminiModel>,
}

#[derive(Deserialize)]
struct GeminiModel {
    name: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
    #[serde(rename = "supportedGenerationMethods", default)]
    supported_generation_methods: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct ClaudeModelsResponse {
    #[serde(default)]
    data: Vec<ClaudeModel>,
}

#[derive(Deserialize)]
struct ClaudeModel {
    id: String,
    #[serde(rename = "displayName", default)]
    display_name: Option<String>,
}

fn normalize_base_url(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

// 从供应商接口拉取可用模型列表
#[tauri::command]
pub async fn list_models(
    base_url: String,
    api_key: String,
    protocol: String,
) -> Result<Vec<RemoteModel>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let base = normalize_base_url(&base_url);

    match protocol.as_str() {
        "google" => {
            let url = format!("{}/v1beta/models", base);
            let resp = client
                .get(&url)
                // ⚠ 这一条把 API Key 放进**查询串**。reqwest 的错误 Display 会把完整 URL
                // （含查询串）追加进错误文本，因此下文所有 `map_err` 都必须先 `without_url()`，
                // 否则密钥会随错误文本流回前端并被持久化进 app-data.json（REQ-007 实测泄漏路径）。
                .query(&[("key", api_key.as_str()), ("pageSize", "200")])
                .send()
                .await
                .map_err(|e| format!("请求失败: {}", e.without_url()))?;

            if !resp.status().is_success() {
                // 只报状态码，不回显 url（该 url 自身不含密钥，但保持一致口径便于将来复用）。
                return Err(format!("接口返回 {}", resp.status()));
            }

            let parsed: GeminiModelsResponse = resp
                .json()
                .await
                .map_err(|e| format!("解析响应失败: {}", e.without_url()))?;

            let models = parsed
                .models
                .into_iter()
                // 仅保留支持文本/图片生成调用的模型
                .filter(|m| {
                    m.supported_generation_methods
                        .as_ref()
                        .map(|methods| methods.iter().any(|s| s == "generateContent"))
                        .unwrap_or(true)
                })
                .map(|m| {
                    let id = m.name.trim_start_matches("models/").to_string();
                    RemoteModel {
                        id,
                        label: m.display_name,
                    }
                })
                .collect();

            Ok(models)
        }
        "claude" => {
            let url = format!("{}/v1/models", base);
            let resp = client
                .get(&url)
                .header("x-api-key", &api_key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
                // 密钥走请求头，reqwest 的 Display 不包含头部，故此处无泄漏；
                // 仍统一用 without_url() 保持口径一致（避免将来源 URL 写进用户可见的错误）。
                .map_err(|e| format!("请求失败: {}", e.without_url()))?;

            if !resp.status().is_success() {
                return Err(format!("接口返回 {} ({})", resp.status(), url));
            }

            let parsed: ClaudeModelsResponse =
                resp.json().await.map_err(|e| format!("解析响应失败: {}", e))?;

            Ok(parsed
                .data
                .into_iter()
                .map(|m| RemoteModel {
                    id: m.id,
                    label: m.display_name,
                })
                .collect())
        }
        // openai / openaiResponses 及所有 OpenAI 兼容网关
        _ => {
            let url = format!("{}/v1/models", base);
            let resp = client
                .get(&url)
                .header("Authorization", format!("Bearer {}", api_key))
                .send()
                .await
                // 密钥走 Authorization 头（Display 不含头部），仍统一 without_url() 保持口径一致。
                .map_err(|e| format!("请求失败: {}", e.without_url()))?;

            if !resp.status().is_success() {
                return Err(format!("接口返回 {}", resp.status()));
            }

            let parsed: OpenAIModelsResponse = resp
                .json()
                .await
                .map_err(|e| format!("解析响应失败: {}", e.without_url()))?;

            Ok(parsed
                .data
                .into_iter()
                .map(|m| RemoteModel {
                    id: m.id,
                    label: None,
                })
                .collect())
        }
    }
}
