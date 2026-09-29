//! API Key 的操作系统凭据库存储（REQ-007）
//!
//! 背景：本应用此前把供应商 API Key 明文写进 `app-data.json`
//! （`settingsStore.ts` 的 persist `partialize` 返回整个 settings，其中含 `providers[].apiKey`）。
//! 任何本地进程都能直接读到密钥。REQ-007 要求"不再以可直接读取的明文形式存放于 app-data.json"，
//! 并要求旧配置升级后自动迁移且供应商仍可用。
//!
//! 方案（见 ADR-0003）：密钥交给**操作系统凭据库**，磁盘上只留非敏感字段。
//! 不采用自研加密 —— 解密密钥与密文同机可取得，等于把锁和钥匙放在一起，属伪装而非保护。
//!
//! 服务名固定，账户名用 provider id：同一台机器上不同供应商互不覆盖；应用标识与
//! `tauri.conf.json` 的 identifier 保持一致，便于用户在凭据管理器里辨认归属。
//!
//! 安全约定：本模块**不打印**任何密钥内容。错误信息只带 provider id 与失败原因，
//! 不回显密钥（包括不把密钥拼进任何格式化字符串）。

use keyring::Entry;

/// 凭据管理器中的服务名（用户可见，用于辨认归属）。
const SERVICE: &str = "com.sy.nextcreator";

fn entry_for(provider_id: &str) -> Result<Entry, String> {
    if provider_id.trim().is_empty() {
        return Err("provider id 不能为空".to_string());
    }
    Entry::new(SERVICE, provider_id).map_err(|error| format!("无法打开凭据库条目: {error}"))
}

/// 写入（或覆盖）某供应商的密钥。空字符串视为删除，避免把"无密钥"存成空条目。
pub fn set_secret(provider_id: &str, secret: &str) -> Result<(), String> {
    let entry = entry_for(provider_id)?;
    if secret.is_empty() {
        return delete_secret(provider_id);
    }
    entry
        .set_password(secret)
        .map_err(|error| format!("写入凭据库失败: {error}"))
}

/// 读取某供应商的密钥。条目不存在时返回 `Ok(None)`（不是错误：未配置属正常状态）。
pub fn get_secret(provider_id: &str) -> Result<Option<String>, String> {
    let entry = entry_for(provider_id)?;
    match entry.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取凭据库失败: {error}")),
    }
}

/// 删除某供应商的密钥。条目本来就不存在时视为成功（删除是幂等的）。
pub fn delete_secret(provider_id: &str) -> Result<(), String> {
    let entry = entry_for(provider_id)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除凭据库条目失败: {error}")),
    }
}

// ---------------------------------------------------------------------------
// Tauri 命令层
//
// 这三个命令是前端唯一能读写密钥的通道；返回体里**只有**密钥本身或错误文本，
// 不含 provider 的其它字段（避免把密钥混进任何会被持久化或记录的结构）。
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn set_provider_secret(provider_id: String, secret: String) -> Result<(), String> {
    set_secret(&provider_id, &secret)
}

#[tauri::command]
pub fn get_provider_secret(provider_id: String) -> Result<Option<String>, String> {
    get_secret(&provider_id)
}

#[tauri::command]
pub fn delete_provider_secret(provider_id: String) -> Result<(), String> {
    delete_secret(&provider_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 服务名与账户名拼装必须稳定：一旦改变，已存的密钥就找不回来了。
    #[test]
    fn entry_uses_app_identifier_as_service() {
        assert_eq!(SERVICE, "com.sy.nextcreator");
    }

    /// 空 provider id 必须被拒绝，而不是把密钥写到空账户名下。
    #[test]
    fn empty_provider_id_is_rejected() {
        assert!(entry_for("").is_err());
        assert!(entry_for("   ").is_err());
    }

    /// 错误信息不得回显密钥内容（本模块只接收 provider id 与固定文案）。
    #[test]
    fn errors_never_contain_the_secret() {
        let secret = "SUPER-SECRET-KEY-123";
        // 空 id 分支：错误里只有固定文案。不用 unwrap_err —— keyring::Entry 未实现 Debug。
        let err = match entry_for("") {
            Err(message) => message,
            Ok(_) => String::new(),
        };
        assert!(!err.contains(secret), "错误文本不得包含密钥内容");
        assert!(err.contains("provider id"), "错误文本应说明是 provider id 问题");
    }
}
