import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { X, MessageSquare, Check, AlertTriangle } from "lucide-react";
import { useModal, getModalAnimationClasses } from "@/hooks/useModal";

interface PromptEditorModalProps {
  initialValue: string;
  onSave: (value: string) => void;
  onClose: () => void;
  title?: string;
}

// 提示词编辑弹窗组件
// 使用 Portal 渲染到 body，避免被节点的 transform 影响导致画布模糊
export function PromptEditorModal({
  initialValue,
  onSave,
  onClose,
  title = "编辑提示词",
}: PromptEditorModalProps) {
  const [value, setValue] = useState(initialValue);
  // 确认对话框状态
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  // 统一 Modal 交互（背景点击、过渡动画；ESC 由下方自定义处理，区分确认框）
  const { isVisible, isClosing, handleClose: closeWithAnimation, handleBackdropClick } = useModal({
    isOpen: true,
    onClose,
    enableEscClose: false,
  });

  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  // 检测内容是否有变化
  const hasChanges = useMemo(() => value !== initialValue, [value, initialValue]);

  // 进入时聚焦到文本框末尾
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(value.length, value.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 尝试关闭 - 检查是否有未保存的更改
  const handleClose = useCallback(() => {
    if (hasChanges) {
      // 有未保存的更改，显示确认对话框
      setShowConfirmDialog(true);
    } else {
      // 没有更改，直接关闭
      closeWithAnimation();
    }
  }, [hasChanges, closeWithAnimation]);

  // 确认对话框：保存并关闭
  const handleConfirmSave = useCallback(() => {
    onSave(value);
    setShowConfirmDialog(false);
    closeWithAnimation();
  }, [value, onSave, closeWithAnimation]);

  // 确认对话框：不保存直接关闭
  const handleConfirmDiscard = useCallback(() => {
    setShowConfirmDialog(false);
    closeWithAnimation();
  }, [closeWithAnimation]);

  // 确认对话框：取消（返回编辑）
  const handleConfirmCancel = useCallback(() => {
    setShowConfirmDialog(false);
  }, []);

  // 保存并关闭
  const handleSave = useCallback(() => {
    onSave(value);
    closeWithAnimation();
  }, [value, onSave, closeWithAnimation]);

  // ESC 键关闭，Ctrl/Cmd + Enter 保存
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showConfirmDialog) {
          // 确认对话框打开时，ESC 关闭确认对话框
          setShowConfirmDialog(false);
        } else {
          handleClose();
        }
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleClose, handleSave, showConfirmDialog]);

  return createPortal(
    <div
      className={`nc-modal-backdrop p-4 ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      {/* Modal 内容 */}
      <div
        className={`
          nc-modal w-full max-w-2xl overflow-hidden
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="nc-modal-header nc-node-header-accent nc-node-accent-blue">
          <div className="flex items-center gap-2">
            <span className="nc-node-header-icon">
              <MessageSquare className="w-5 h-5" />
            </span>
            <span className="nc-modal-title">{title}</span>
          </div>
          <button
            type="button"
            className="nc-icon-btn"
            onClick={handleClose}
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 编辑区域 */}
        <div className="p-4">
          <textarea
            ref={textareaRef}
            className="textarea textarea-bordered w-full h-[300px] text-sm resize-none focus:outline-none focus:border-primary"
            placeholder="输入提示词描述..."
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
            }}
          />
        </div>

        {/* 底部操作栏 */}
        <div className="nc-modal-footer">
          <span className="nc-modal-footer-hint">
            按 ESC 取消 · Ctrl/Cmd + Enter 保存
          </span>
          <div className="flex items-center gap-2">
            <button className="btn btn-ghost btn-sm" onClick={handleClose}>
              取消
            </button>
            <button className="btn btn-primary btn-sm gap-1" onClick={handleSave}>
              <Check className="w-4 h-4" />
              保存
            </button>
          </div>
        </div>
      </div>

      {/* 未保存确认对话框（嵌套层级） */}
      {showConfirmDialog && (
        <div
          className="nc-modal-backdrop nc-modal-backdrop-nested p-4"
          style={{ backgroundColor: "rgba(0, 0, 0, 0.4)" }}
          onClick={handleConfirmCancel}
        >
          <div
            className="nc-panel-lg w-full max-w-sm overflow-hidden modal-content-enter"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 警告头部 */}
            <div className="flex items-center gap-3 px-4 py-3 bg-warning/10 border-b border-warning/20">
              <div className="p-2 bg-warning/20 rounded-[var(--nc-radius-md)]">
                <AlertTriangle className="w-5 h-5 text-warning" />
              </div>
              <div>
                <h3 className="nc-modal-title">未保存的更改</h3>
                <p className="nc-modal-subtitle mt-0">您有尚未保存的内容</p>
              </div>
            </div>

            {/* 选项按钮 */}
            <div className="p-4 space-y-2">
              <button
                className="btn btn-primary btn-sm w-full gap-2"
                onClick={handleConfirmSave}
              >
                <Check className="w-4 h-4" />
                保存更改
              </button>
              <button
                className="btn btn-ghost btn-sm w-full text-error hover:bg-error/10"
                onClick={handleConfirmDiscard}
              >
                不保存，直接关闭
              </button>
              <button
                className="btn btn-ghost btn-sm w-full"
                onClick={handleConfirmCancel}
              >
                取消，继续编辑
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
