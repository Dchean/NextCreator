import { X, Keyboard } from "lucide-react";
import { createPortal } from "react-dom";
import { useModal, getModalAnimationClasses } from "@/hooks/useModal";

interface ShortcutGroup {
  title: string;
  shortcuts: { keys: string[]; description: string }[];
}

interface KeyboardShortcutsPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export function KeyboardShortcutsPanel({ isOpen, onClose }: KeyboardShortcutsPanelProps) {
  const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const cmdKey = isMac ? "⌘" : "Ctrl";

  // 使用统一的 modal hook
  const { isVisible, isClosing, handleClose, handleBackdropClick } = useModal({
    isOpen,
    onClose,
  });

  // 获取动画类名
  const { contentClasses } = getModalAnimationClasses(isVisible, isClosing);

  const shortcutGroups: ShortcutGroup[] = [
    {
      title: "基本操作",
      shortcuts: [
        { keys: ["Delete", "Backspace"], description: "删除选中的节点或连线" },
        { keys: [`${cmdKey}`, "C"], description: "复制选中的节点" },
        { keys: [`${cmdKey}`, "V"], description: "粘贴节点" },
        { keys: [`${cmdKey}`, "D"], description: "创建选中节点的副本" },
        { keys: [`${cmdKey}`, "A"], description: "全选所有节点" },
        { keys: ["Esc"], description: "取消选择" },
      ],
    },
    {
      title: "连线操作",
      shortcuts: [
        { keys: ["拖拽连线端点"], description: "改接连线到其他连接点" },
        { keys: ["拖拽端点到空白处"], description: "断开（删除）连线" },
        { keys: ["Delete", "Backspace"], description: "删除选中的连线" },
        { keys: ["右键点击连线"], description: "连线菜单（删除连线）" },
      ],
    },
    {
      title: "撤销与重做",
      shortcuts: [
        { keys: [`${cmdKey}`, "Z"], description: "撤销上一步操作" },
        { keys: [`${cmdKey}`, "Shift", "Z"], description: "重做操作" },
      ],
    },
    {
      title: "布局与整理",
      shortcuts: [
        { keys: [`${cmdKey}`, "O"], description: "自动整理节点布局" },
      ],
    },
    {
      title: "多选操作",
      shortcuts: [
        { keys: [`${cmdKey}`, "单击"], description: "添加/移除节点到选区" },
        { keys: ["Shift", "单击"], description: "添加/移除节点到选区" },
        { keys: ["拖拽框选"], description: "框选多个节点" },
      ],
    },
    {
      title: "画布导航",
      shortcuts: [
        { keys: ["鼠标滚轮"], description: "缩放画布" },
        { keys: ["鼠标中键拖拽"], description: "平移画布" },
        { keys: ["右键拖拽"], description: "平移画布" },
      ],
    },
  ];

  if (!isOpen) {
    return null;
  }

  return createPortal(
    <div
      className={`nc-modal-backdrop ${isVisible && !isClosing ? "nc-modal-backdrop-open" : ""}`}
      onClick={handleBackdropClick}
    >
      {/* Modal 内容 */}
      <div
        className={`
          nc-modal w-[500px] max-h-[80vh]
          transition-all duration-200 ease-out
          ${contentClasses}
        `}
      >
        {/* 头部 */}
        <div className="nc-modal-header">
          <div className="flex items-center gap-2">
            <Keyboard className="w-5 h-5 text-primary" />
            <h2 className="nc-modal-title">键盘快捷键</h2>
          </div>
          <button
            className="nc-icon-btn"
            onClick={handleClose}
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 内容 */}
        <div className="nc-modal-body max-h-[calc(80vh-80px)]">
          <div className="space-y-6">
            {shortcutGroups.map((group) => (
              <div key={group.title}>
                <h3 className="nc-section-title-sm mb-3">
                  {group.title}
                </h3>
                <div className="space-y-2">
                  {group.shortcuts.map((shortcut, index) => (
                    <div
                      key={index}
                      className="flex items-center justify-between py-1.5"
                    >
                      <span className="text-sm">{shortcut.description}</span>
                      <div className="flex items-center gap-1">
                        {shortcut.keys.map((key, keyIndex) => (
                          <span key={keyIndex} className="flex items-center gap-1">
                            <kbd className="nc-kbd">
                              {key}
                            </kbd>
                            {keyIndex < shortcut.keys.length - 1 && (
                              <span className="text-base-content/40">+</span>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* 提示 */}
          <div className="mt-4">
            <hr className="nc-divider" />
            <p className="text-xs text-base-content/50 text-center">
              按 <kbd className="nc-kbd">Esc</kbd> 或 <kbd className="nc-kbd">?</kbd> 关闭此面板
            </p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
