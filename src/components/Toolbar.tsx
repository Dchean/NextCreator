/**
 * 顶部标题条（客户端为无标题栏窗口，本组件即自定义标题栏）：
 * 左侧 Logo + 版本；整条是窗口拖拽区；右侧是最小化/最大化/关闭。
 * 原顶部中央的工作流操作已移至底部悬浮工具条（FloatingToolbar），
 * 原右上角的设置类入口已移至左侧边栏底部（Sidebar rail）。
 */
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logoImage from "@/assets/logo.png";
// 版本号单一来源：package.json（Vite 构建时会把整包内联，运行时无网络请求）。
// 此前这里是写死的字符串，版本升级时极易漏改（画布内长期显示旧版本号）。
import packageJson from "../../package.json";

export function Toolbar() {
  return (
    <div className="nc-toolbar flex items-center justify-between px-4" data-tauri-drag-region>
      {/* 左侧 Logo（同样是拖拽区） */}
      <div className="flex items-center gap-3" data-tauri-drag-region>
        <div className="flex items-center gap-2">
          <img src={logoImage} alt="NextCreator" className="w-8 h-8 rounded-md" />
          <span className="text-base font-bold leading-none">NextCreator</span>
        </div>
        <div className="nc-badge">v{packageJson.version}</div>
      </div>

      <WindowControls />
    </div>
  );
}

/**
 * 无标题栏窗口的最小化/最大化/关闭。
 * 仅 Tauri 运行时渲染（浏览器开发模式没有窗口可控制）；
 * 注意：窗口控制按钮**不能**带 data-tauri-drag-region，否则点击会被当成拖拽。
 */
function WindowControls() {
  // invoke 依赖 __TAURI_INTERNALS__；它不在就意味着没有窗口可控制（纯浏览器开发模式）
  if (!("__TAURI_INTERNALS__" in window)) return null;

  let appWindow: ReturnType<typeof getCurrentWindow> | null = null;
  try {
    appWindow = getCurrentWindow();
  } catch {
    appWindow = null;
  }
  if (!appWindow) return null;

  return (
    <div className="flex items-center gap-0.5">
      <button
        className="nc-icon-btn"
        onClick={() => void appWindow!.minimize()}
        aria-label="最小化"
      >
        <Minus className="w-4 h-4" />
      </button>
      <button
        className="nc-icon-btn"
        onClick={() => void appWindow!.toggleMaximize()}
        aria-label="最大化/还原"
      >
        <Square className="w-3.5 h-3.5" />
      </button>
      <button
        className="nc-icon-btn nc-icon-btn-danger"
        onClick={() => void appWindow!.close()}
        aria-label="关闭窗口"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
