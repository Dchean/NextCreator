import { useState } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Pencil, Trash2, Server, Zap } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useModelListStore } from "@/services/modelListService";
// REQ-007：密钥改存 OS 凭据库，此处是唯一的写入入口。
import { setProviderApiKey } from "@/services/secretStore";
import { useToastStore } from "@/stores/toastStore";
import { Input } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useModal, getModalAnimationClasses } from "@/hooks/useModal";
import type { Provider, ProviderProtocol } from "@/types";

// 协议类型配置
const protocolConfig: { key: ProviderProtocol; label: string }[] = [
  { key: "openai", label: "OpenAI" },
  { key: "openaiResponses", label: "OpenAI Responses" },
  { key: "google", label: "Google" },
  { key: "claude", label: "Claude" },
];

// 协议类型显示标签
const protocolLabels: Record<ProviderProtocol, string> = {
  openai: "OpenAI",
  openaiResponses: "OpenAI Responses",
  google: "Google",
  claude: "Claude",
};

export function ProviderPanel() {
  const {
    settings,
    isProviderPanelOpen,
    closeProviderPanel,
    addProvider,
    updateProvider,
    removeProvider,
  } = useSettingsStore();

  // 编辑/添加供应商的弹窗状态
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [isAddingProvider, setIsAddingProvider] = useState(false);
  // 删除确认状态
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  // 供应商连接测试状态
  const [testStates, setTestStates] = useState<
    Record<string, { status: "loading" | "ok" | "error"; modelCount?: number; error?: string }>
  >({});

  // 测试连接：拉取模型列表并显示结果
  const handleTestProvider = async (provider: Provider) => {
    setTestStates((prev) => ({ ...prev, [provider.id]: { status: "loading" } }));
    try {
      await useModelListStore.getState().fetchModels(provider, true);
      const entry = useModelListStore.getState().entries[provider.id];
      if (entry?.error) {
        setTestStates((prev) => ({ ...prev, [provider.id]: { status: "error", error: entry.error } }));
      } else {
        setTestStates((prev) => ({
          ...prev,
          [provider.id]: { status: "ok", modelCount: entry?.models.length ?? 0 },
        }));
      }
    } catch (e) {
      setTestStates((prev) => ({
        ...prev,
        [provider.id]: { status: "error", error: e instanceof Error ? e.message : String(e) },
      }));
    }
  };

  // 使用统一的 modal hook
  const { isVisible, isClosing, handleClose, handleBackdropClick } = useModal({
    isOpen: isProviderPanelOpen,
    onClose: closeProviderPanel,
  });

  // 获取动画类名
  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  if (!isProviderPanelOpen) return null;

  // 确保 providers 数组存在
  const providers = settings.providers || [];

  // 删除供应商 - 显示确认弹窗
  const handleDeleteProvider = (provider: Provider) => {
    setDeleteConfirm({ id: provider.id, name: provider.name });
  };

  // 执行确认的删除操作
  const executeDelete = () => {
    if (!deleteConfirm) return;
    const { id } = deleteConfirm;
    setDeleteConfirm(null);
    removeProvider(id);
  };

  return createPortal(
    <div
      className={`nc-modal-backdrop ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      {/* Modal 内容 */}
      <div
        className={`
          nc-modal nc-modal-lg mx-4 max-h-[90vh] flex flex-col
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
      >
        {/* 头部 */}
        <div className="nc-modal-header">
          <div className="flex items-center gap-3">
            <Server className="w-5 h-5 text-primary" />
            <h2 className="nc-modal-title">供应商管理</h2>
          </div>
          <button
            className="nc-icon-btn"
            onClick={handleClose}
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 - 可滚动 */}
        <div className="nc-modal-body space-y-5">
          {/* 供应商列表区域 */}
          <div className="space-y-2">
            <h3 className="nc-section-title">
              供应商列表
            </h3>

            {/* 供应商卡片列表 */}
            {providers.length === 0 ? (
              <div className="nc-empty-state">
                <Server className="h-8 w-8 opacity-40" />
                <p className="nc-empty-state-title">暂无供应商</p>
                <p className="nc-empty-state-hint">点击下方按钮添加</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {providers.map((provider) => {
                  const testState = testStates[provider.id];
                  return (
                  <div
                    key={provider.id}
                    className="nc-soft-panel flex items-center justify-between p-2.5!"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{provider.name}</span>
                        <span className="nc-chip nc-chip-neutral shrink-0">
                          {protocolLabels[provider.protocol] || "Google"}
                        </span>
                        {testState?.status === "loading" && (
                          <span className="nc-chip nc-chip-info shrink-0">
                            测试中...
                          </span>
                        )}
                        {testState?.status === "ok" && (
                          <span className="nc-chip nc-chip-success shrink-0">
                            连接正常 · {testState.modelCount} 个模型
                          </span>
                        )}
                        {testState?.status === "error" && (
                          <span
                            className="nc-chip nc-chip-error shrink-0 truncate max-w-[160px]"
                            title={testState.error}
                          >
                            {testState.error}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-base-content/40 truncate">
                        {provider.baseUrl}
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 ml-2">
                      <button
                        className="nc-icon-btn nc-icon-btn-xs"
                        title="测试连接（获取模型列表）"
                        disabled={testState?.status === "loading"}
                        onClick={() => void handleTestProvider(provider)}
                      >
                        <Zap className={`w-3.5 h-3.5 ${testState?.status === "loading" ? "animate-pulse" : ""}`} />
                      </button>
                      <button
                        className="nc-icon-btn nc-icon-btn-xs"
                        onClick={() => setEditingProvider(provider)}
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button
                        className="nc-icon-btn nc-icon-btn-xs nc-icon-btn-danger"
                        onClick={() => handleDeleteProvider(provider)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                  );
                })}
              </div>
            )}

            {/* 添加供应商按钮 */}
            <button
              className="btn btn-outline btn-sm w-full gap-2"
              onClick={() => setIsAddingProvider(true)}
            >
              <Plus className="w-4 h-4" />
              添加供应商
            </button>
          </div>
        </div>

        {/* 底部 - 简化为关闭按钮 */}
        <div className="nc-modal-footer">
          <div className="nc-modal-footer-hint flex items-center gap-1.5">
            <Zap className="w-3 h-3" />
            <span>更改即时生效</span>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={handleClose}>
            关闭
          </button>
        </div>
      </div>

      {/* 添加/编辑供应商弹窗 */}
      {(isAddingProvider || editingProvider) && (
        <ProviderEditModal
          provider={editingProvider}
          onSave={async (data) => {
            // REQ-007：密钥改存系统凭据库，settings 只在**内存**里保留真实密钥
            // （落盘前由 settingsStore 的 partialize 统一清空）。
            // 顺序：先拿到 provider id（新增则先建条目），再写凭据库 ——
            // 避免出现"settings 已配置、凭据库里还没有"的中间态。
            const inputKey = data.apiKey;
            const providerId = editingProvider ? editingProvider.id : addProvider(data);

            if (editingProvider) {
              // 编辑时输入框留空 = 沿用已有密钥：**不能**把空串写进 settings，
              // 否则内存里的真实密钥会被抹掉，UI 的"已配置"判定与请求都会失效。
              await updateProvider(editingProvider.id, inputKey ? data : { ...data, apiKey: undefined });
            }
            if (inputKey) {
              try {
                await setProviderApiKey(providerId, inputKey);
                // 让内存与凭据库一致（编辑既有供应商时尤其重要）。
                await updateProvider(providerId, { apiKey: inputKey });
              } catch (error) {
                // 凭据库不可用时如实报错；密钥不会进磁盘（partialize 兜底），
                // 但必须让用户知道现在密钥**没有**保存成功。
                console.error("[ProviderPanel] 写入系统凭据库失败:", error);
                useToastStore
                  .getState()
                  .error("保存密钥失败：系统凭据库不可用。密钥未保存，请检查系统凭据库后重试");
              }
            }
            setEditingProvider(null);
            setIsAddingProvider(false);
          }}
          onClose={() => {
            setEditingProvider(null);
            setIsAddingProvider(false);
          }}
        />
      )}

      {/* 删除确认弹窗 */}
      {deleteConfirm && (
        <ConfirmDialog
          tone="error"
          title="确认删除"
          message={`确定要删除供应商「${deleteConfirm.name}」吗？相关节点配置也会被清除，此操作不可撤销。`}
          confirmText="确认删除"
          onConfirm={executeDelete}
          onClose={() => setDeleteConfirm(null)}
        />
      )}
    </div>,
    document.body
  );
}

// 供应商编辑弹窗组件
interface ProviderEditModalProps {
  provider: Provider | null;
  onSave: (data: Omit<Provider, "id">) => void;
  onClose: () => void;
}

function ProviderEditModal({ provider, onSave, onClose }: ProviderEditModalProps) {
  const [name, setName] = useState(provider?.name || "");
  // REQ-007：settings 里不再持有明文密钥，因此编辑已有供应商时输入框**留空**，
  // 语义是"不改动已保存的密钥"（新密钥只有用户真的输入时才会覆盖凭据库里的值）。
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || "");
  const [protocol, setProtocol] = useState<ProviderProtocol>(provider?.protocol || "google");

  // 使用统一的 modal hook
  const { isVisible, isClosing, handleClose, handleBackdropClick } = useModal({
    isOpen: true,
    onClose,
  });

  // 获取动画类名
  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  const isEditing = !!provider;
  // 新增时必须填密钥；编辑时允许留空（表示沿用凭据库中已有的密钥）。
  const canSave = Boolean(name.trim()) && Boolean(baseUrl.trim()) && (isEditing || Boolean(apiKey.trim()));

  const handleSave = () => {
    if (!canSave) return;
    onSave({
      name: name.trim(),
      // 留空即"不改密钥"：交给调用方判断（它只在非空时才写凭据库）。
      apiKey: apiKey.trim(),
      baseUrl: baseUrl.trim(),
      protocol,
    });
  };

  return (
    <div
      className={`nc-modal-backdrop nc-modal-backdrop-nested ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      {/* Modal 内容 */}
      <div
        className={`
          nc-modal nc-modal-sm mx-4
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
      >
        {/* 头部 */}
        <div className="nc-modal-header">
          <h3 className="nc-modal-title">
            {isEditing ? "编辑供应商" : "添加供应商"}
          </h3>
          <button
            className="nc-icon-btn"
            onClick={handleClose}
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 协议类型选择 Tab */}
        <div className="px-5 pt-4">
          <div className="flex bg-base-200 rounded-[var(--nc-radius-md)] p-1">
            {protocolConfig.map(({ key, label }) => (
              <button
                key={key}
                className={`
                  flex-1 py-1.5 px-3 text-sm font-medium rounded-[var(--nc-radius-sm)] transition-colors
                  ${protocol === key
                    ? "bg-base-100 text-base-content shadow-sm"
                    : "text-base-content/60 hover:text-base-content"
                  }
                `}
                onClick={() => setProtocol(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 表单 */}
        <div className="p-5 space-y-4">
          {/* 名称 */}
          <div className="form-control">
            <label className="nc-field-label">名称</label>
            <Input
              placeholder="例如：我的 API 服务"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* API Key */}
          <div className="form-control">
            <label className="nc-field-label">API Key</label>
            <Input
              isPassword
              placeholder="输入 API Key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          {/* Base URL */}
          <div className="form-control">
            <label className="nc-field-label">Base URL（必填）</label>
            <Input
              placeholder="例如：https://api.example.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
            <p className="mt-1 text-xs nc-subtle">
              无需填写版本路径（如 /v1beta）
            </p>
          </div>
        </div>

        {/* 底部 */}
        <div className="nc-modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={handleClose}>
            取消
          </button>
          <button
            className="btn btn-primary btn-sm"
            onClick={handleSave}
            disabled={!canSave}
          >
            {isEditing ? "保存" : "添加"}
          </button>
        </div>
      </div>
    </div>
  );
}
