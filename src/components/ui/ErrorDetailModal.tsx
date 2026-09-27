import { useState, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, Copy, AlertCircle, Check, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "@/stores/toastStore";
import { useModal, getModalAnimationClasses } from "@/hooks/useModal";
import type { ErrorDetails } from "@/types";

interface ErrorDetailModalProps {
  error: string;
  errorDetails?: ErrorDetails;  // 可选的详细错误信息
  title?: string;
  onClose: () => void;
}

// 错误信息字段的中文名称映射
const fieldLabels: Record<string, string> = {
  name: "错误名称",
  message: "错误信息",
  stack: "堆栈信息",
  cause: "错误原因",
  statusCode: "状态码",
  requestUrl: "请求路径",
  requestBody: "请求体",
  responseHeaders: "响应首部",
  responseBody: "响应内容",
  timestamp: "发生时间",
  nodeId: "节点 ID",
  model: "模型",
  provider: "供应商",
};

// 字段显示顺序
const fieldOrder = [
  "name",
  "message",
  "statusCode",
  "requestUrl",
  "model",
  "provider",
  "timestamp",
  "requestBody",
  "responseHeaders",
  "responseBody",
  "cause",
  "stack",
];

// 格式化时间为中国时间
function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return isoString;
  }
}

/**
 * 错误详情弹窗组件
 * 用于显示节点执行过程中的完整错误信息
 */
export function ErrorDetailModal({ error, errorDetails, title = "错误详情", onClose }: ErrorDetailModalProps) {
  const [copied, setCopied] = useState(false);
  const [expandedFields, setExpandedFields] = useState<Set<string>>(new Set(["message", "cause"]));

  // 使用统一的 modal hook（ESC 关闭、背景点击、过渡动画）
  const { isVisible, isClosing, handleClose, handleBackdropClick } = useModal({
    isOpen: true,
    onClose,
  });

  // 获取动画类名
  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  // 智能解析错误字符串，尝试提取结构化信息
  const parseErrorString = useCallback((errorString: string): Partial<ErrorDetails> => {
    const result: Partial<ErrorDetails> = {
      message: errorString,
      timestamp: new Date().toISOString(),
    };

    // 尝试提取状态码，格式如 "API 返回错误 (503): ..."
    const statusCodeMatch = errorString.match(/\((\d{3})\)/);
    if (statusCodeMatch) {
      result.statusCode = parseInt(statusCodeMatch[1], 10);
    }

    // 尝试提取错误类型
    const errorTypeMatch = errorString.match(/^([A-Z][a-zA-Z_]+Error):/);
    if (errorTypeMatch) {
      result.name = errorTypeMatch[1];
    } else if (errorString.includes("API 返回错误")) {
      result.name = "API_Error";
    } else if (errorString.includes("网络") || errorString.includes("Network") || errorString.includes("无法连接")) {
      result.name = "NetworkError";
    } else if (errorString.includes("超时") || errorString.includes("timeout")) {
      result.name = "TimeoutError";
    } else if (errorString.includes("解析") || errorString.includes("parse")) {
      result.name = "ParseError";
    } else {
      result.name = "Error";
    }

    // 尝试提取响应内容
    // 格式如 "API 返回错误 (503): {...}" 或 "API 返回错误 (503): some text"
    const responseMatch = errorString.match(/API 返回错误\s*\(\d{3}\)[：:]\s*([\s\S]*)/);
    if (responseMatch) {
      const responseContent = responseMatch[1].trim();
      // 尝试解析为 JSON
      try {
        result.responseBody = JSON.parse(responseContent);
      } catch {
        // 如果不是 JSON，作为纯文本保存
        if (responseContent) {
          result.responseBody = responseContent;
        }
      }
    }

    // 尝试解析整个字符串为 JSON（可能是完整的错误对象）
    try {
      const parsed = JSON.parse(errorString);
      if (typeof parsed === "object" && parsed !== null) {
        return { ...result, ...parsed };
      }
    } catch {
      // 尝试提取错误消息中嵌入的 JSON
      const jsonMatch = errorString.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const embeddedJson = JSON.parse(jsonMatch[0]);
          if (embeddedJson.error) {
            result.cause = embeddedJson.error;
          } else if (!result.responseBody) {
            result.cause = embeddedJson;
          }
        } catch {
          // 忽略解析失败
        }
      }
    }

    return result;
  }, []);

  // 合并 errorDetails 和从字符串解析的信息
  const parsedError = useMemo(() => {
    const fromString = parseErrorString(error);
    if (errorDetails) {
      return { ...fromString, ...errorDetails };
    }
    return fromString;
  }, [error, errorDetails, parseErrorString]);

  // 生成可复制的完整错误文本
  const getFullErrorText = useCallback(() => {
    const lines: string[] = [];

    for (const field of fieldOrder) {
      const value = parsedError[field as keyof ErrorDetails];
      if (value !== undefined && value !== null && value !== "") {
        const label = fieldLabels[field] || field;
        if (typeof value === "object") {
          lines.push(`${label}: ${JSON.stringify(value, null, 2)}`);
        } else {
          lines.push(`${label}: ${value}`);
        }
      }
    }

    return lines.join("\n");
  }, [parsedError]);

  // 复制错误信息
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(getFullErrorText());
      setCopied(true);
      toast.success("错误信息已复制到剪贴板");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("复制失败");
    }
  }, [getFullErrorText]);

  // 切换字段展开状态
  const toggleField = (field: string) => {
    setExpandedFields(prev => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
      return next;
    });
  };

  // 渲染单个字段
  const renderField = (field: string, value: unknown) => {
    if (value === undefined || value === null || value === "") return null;

    const label = fieldLabels[field] || field;
    const isObject = typeof value === "object";
    const isLongText = typeof value === "string" && value.length > 200;
    const isExpandable = isObject || isLongText || field === "stack";
    const isExpanded = expandedFields.has(field);

    // 格式化值
    let displayValue: string;
    if (field === "timestamp" && typeof value === "string") {
      // 时间戳格式化为中国时间
      displayValue = formatTimestamp(value);
    } else if (isObject) {
      displayValue = JSON.stringify(value, null, 2);
    } else {
      displayValue = String(value);
    }

    // 根据字段类型选择不同的样式
    const getFieldStyle = () => {
      switch (field) {
        case "message":
          return "text-error bg-error/5 border-error/20";
        case "statusCode":
          const code = Number(value);
          if (code >= 500) return "text-error bg-error/10";
          if (code >= 400) return "text-warning bg-warning/10";
          return "text-success bg-success/10";
        case "stack":
          return "text-base-content/70 bg-base-200 text-xs";
        default:
          return "text-base-content bg-base-200";
      }
    };

    return (
      <div key={field} className="border-b border-base-300 pb-3 last:border-0">
        <div
          className={`flex items-center gap-1 text-xs font-medium text-base-content/60 mb-1 ${isExpandable ? "cursor-pointer hover:text-base-content" : ""}`}
          onClick={() => isExpandable && toggleField(field)}
        >
          {isExpandable && (
            isExpanded
              ? <ChevronDown className="w-3 h-3" />
              : <ChevronRight className="w-3 h-3" />
          )}
          {label}
          {field === "statusCode" && <span className="ml-1 opacity-50">(HTTP)</span>}
        </div>
        <div
          className={`text-sm break-all whitespace-pre-wrap font-mono p-2 rounded border ${getFieldStyle()} ${
            isExpandable && !isExpanded ? "max-h-20 overflow-hidden relative" : ""
          }`}
        >
          {displayValue}
          {isExpandable && !isExpanded && (
            <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-base-200 to-transparent" />
          )}
        </div>
      </div>
    );
  };

  return createPortal(
    <div
      className={`nc-modal-backdrop p-4 ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      <div
        className={`
          nc-modal nc-modal-xl max-h-[85vh] flex flex-col
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className="nc-modal-header">
          <div className="flex items-center gap-2 text-error">
            <AlertCircle className="w-5 h-5" />
            <span className="nc-modal-title">{title}</span>
            {parsedError.statusCode && (
              <span className={`nc-chip ${
                parsedError.statusCode >= 500 ? "nc-chip-error" :
                parsedError.statusCode >= 400 ? "nc-chip-warning" :
                "nc-chip-success"
              }`}>
                {parsedError.statusCode}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`btn btn-sm btn-ghost gap-1 ${copied ? "text-success" : ""}`}
              onClick={handleCopy}
            >
              {copied ? (
                <>
                  <Check className="w-4 h-4" />
                  已复制
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  复制全部
                </>
              )}
            </button>
            <button
              type="button"
              className="nc-icon-btn"
              onClick={handleClose}
              aria-label="关闭"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* 错误内容 */}
        <div className="nc-modal-body-sm space-y-3">
          {fieldOrder.map(field => renderField(field, parsedError[field as keyof ErrorDetails]))}
        </div>

        {/* 底部提示 */}
        <div className="nc-modal-footer nc-modal-footer-center">
          <span className="text-xs text-base-content/50">
            点击背景或按 ESC 关闭 · 点击字段名可展开/折叠 · 复制按钮可复制完整错误信息
          </span>
        </div>
      </div>
    </div>,
    document.body
  );
}
