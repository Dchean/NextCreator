import { createPortal } from "react-dom";
import { AlertTriangle, CircleAlert, Info } from "lucide-react";
import { useModal, getModalAnimationClasses } from "@/hooks/useModal";

export type ConfirmTone = "error" | "warning" | "info";

interface ConfirmDialogProps {
  /** 对话框标题 */
  title: string;
  /** 正文说明 */
  message: string;
  /** 确认按钮文案 */
  confirmText?: string;
  /** 取消按钮文案 */
  cancelText?: string;
  /** 语气：error 红色 / warning 橙色 / info 蓝色（info 使用主色按钮） */
  tone?: ConfirmTone;
  onConfirm: () => void;
  onClose: () => void;
}

const toneConfig: Record<
  ConfirmTone,
  { icon: typeof AlertTriangle; chipClass: string; confirmClass: string }
> = {
  error: {
    icon: AlertTriangle,
    chipClass: "bg-error/10 text-error",
    confirmClass: "btn-error",
  },
  warning: {
    icon: CircleAlert,
    chipClass: "bg-warning/10 text-warning",
    confirmClass: "btn-warning",
  },
  info: {
    icon: Info,
    chipClass: "bg-info/10 text-info",
    confirmClass: "btn-primary",
  },
};

/**
 * 统一的确认对话框
 * nc-modal 模态卡片 + 语气色图标 + 右对齐 btn-sm 操作区
 */
export function ConfirmDialog({
  title,
  message,
  confirmText = "确认",
  cancelText = "取消",
  tone = "error",
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const { isVisible, isClosing, handleClose, handleBackdropClick } = useModal({
    isOpen: true,
    onClose,
  });

  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  const toneEntry = toneConfig[tone];
  const Icon = toneEntry.icon;

  return createPortal(
    <div
      className={`nc-modal-backdrop p-4 ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      {/* 对话框内容 */}
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="nc-confirm-dialog-title"
        className={`
          nc-modal nc-modal-sm p-5
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
      >
        <div className="flex items-center gap-3 mb-4">
          <div className={`p-2 rounded-lg ${toneEntry.chipClass}`}>
            <Icon className="w-5 h-5" />
          </div>
          <h3 id="nc-confirm-dialog-title" className="nc-modal-title">{title}</h3>
        </div>
        <p className="text-sm text-base-content/70 mb-5">{message}</p>
        <div className="flex gap-2 justify-end">
          <button className="btn btn-ghost btn-sm" onClick={handleClose}>
            {cancelText}
          </button>
          <button className={`btn btn-sm ${toneEntry.confirmClass}`} onClick={onConfirm}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
