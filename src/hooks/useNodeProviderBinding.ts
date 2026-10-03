import { useEffect, useMemo } from "react";
import { useSettingsStore } from "@/stores/settingsStore";
import { NODE_ALLOWED_PROTOCOLS, type NodeProviderMapping, type ProviderProtocol } from "@/types";

// 协议类型显示标签（Inspector 供应商下拉用）
const PROTOCOL_LABELS: Record<ProviderProtocol, string> = {
  openai: "OpenAI",
  openaiResponses: "OpenAI Responses",
  google: "Google",
  claude: "Claude",
};

/**
 * 节点级供应商绑定：在节点 Inspector 里直接选择该节点使用的供应商。
 * （供应商面板原有的「节点配置/批量分配」手动分配 UI 已移除，这里是唯一绑定入口。）
 *
 * 自动绑定约定：仅当「尚未绑定过（nodeProviders 里没有该 key）」且「兼容供应商恰好只有一个」
 * 时自动绑定——新增供应商后打开节点即可直接拉取模型。用户显式选回"未配置"后 key 仍存在
 * （值为 undefined），不会再被自动绑定覆盖。
 */
export function useNodeProviderBinding(providerKey: keyof NodeProviderMapping) {
  const settings = useSettingsStore((s) => s.settings);
  const setNodeProvider = useSettingsStore((s) => s.setNodeProvider);
  const provider = useSettingsStore((s) => s.getNodeProvider(providerKey));

  const compatibleProviders = useMemo(
    () =>
      settings.providers.filter((p) =>
        NODE_ALLOWED_PROTOCOLS[providerKey].includes(p.protocol)
      ),
    [settings.providers, providerKey]
  );

  useEffect(() => {
    if (provider) return;
    if (providerKey in settings.nodeProviders) return;
    if (compatibleProviders.length === 1) {
      setNodeProvider(providerKey, compatibleProviders[0].id);
    }
  }, [provider, compatibleProviders, providerKey, setNodeProvider, settings.nodeProviders]);

  const selectProvider = (id: string) => {
    setNodeProvider(providerKey, id || undefined);
  };

  const providerOptions = useMemo(
    () => [
      { value: "", label: "未配置" },
      ...compatibleProviders.map((p) => ({
        value: p.id,
        label: `${p.name} (${PROTOCOL_LABELS[p.protocol]})`,
      })),
    ],
    [compatibleProviders]
  );

  return { provider, compatibleProviders, providerOptions, selectProvider };
}
