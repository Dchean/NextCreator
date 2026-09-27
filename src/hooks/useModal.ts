import { useState, useEffect, useCallback } from "react";

interface UseModalOptions {
  /** Modal 是否打开 */
  isOpen: boolean;
  /** 关闭 Modal 的回调函数 */
  onClose: () => void;
  /** 动画持续时间（毫秒），默认 200ms */
  animationDuration?: number;
  /** 是否启用 ESC 键关闭，默认 true */
  enableEscClose?: boolean;
}

interface UseModalReturn {
  /** 是否显示（用于动画） */
  isVisible: boolean;
  /** 是否正在关闭（用于动画） */
  isClosing: boolean;
  /** 处理关闭（带动画） */
  handleClose: () => void;
  /** 处理背景点击关闭 */
  handleBackdropClick: (e: React.MouseEvent) => void;
}

/**
 * 统一的 Modal 交互 hook
 * 提供：ESC 键关闭、点击外部关闭、过渡动画状态管理
 */
export function useModal({
  isOpen,
  onClose,
  animationDuration = 200,
  enableEscClose = true,
}: UseModalOptions): UseModalReturn {
  // 动画状态
  const [isVisible, setIsVisible] = useState(false);
  const [isClosing, setIsClosing] = useState(false);

  // 进入动画
  useEffect(() => {
    if (isOpen) {
      setIsClosing(false);
      // 使用 requestAnimationFrame 确保 DOM 更新后再触发动画
      requestAnimationFrame(() => setIsVisible(true));
    }
  }, [isOpen]);

  // 关闭时先播放退出动画
  const handleClose = useCallback(() => {
    setIsClosing(true);
    setIsVisible(false);
    setTimeout(() => {
      onClose();
      setIsClosing(false);
    }, animationDuration);
  }, [onClose, animationDuration]);

  // ESC 键关闭
  useEffect(() => {
    if (!enableEscClose || !isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, handleClose, enableEscClose]);

  // 处理背景点击关闭
  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      // 确保点击的是背景而不是内容
      if (e.target === e.currentTarget) {
        handleClose();
      }
    },
    [handleClose]
  );

  return {
    isVisible,
    isClosing,
    handleClose,
    handleBackdropClick,
  };
}

/**
 * 获取 Modal 动画类名
 * @param isVisible 是否显示
 * @param isClosing 是否正在关闭
 */
export function getModalAnimationClasses(isVisible: boolean, isClosing: boolean) {
  const backdropClasses = isVisible && !isClosing
    ? "bg-black/60"
    : "bg-black/0";

  const contentClasses = isVisible && !isClosing
    ? "opacity-100 scale-100 translate-y-0"
    : "opacity-0 scale-95 translate-y-4";

  return { backdropClasses, contentClasses };
}
