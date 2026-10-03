import { useCallback, useEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";

import { Toolbar } from "@/components/Toolbar";
import { FlowCanvas } from "@/components/FlowCanvas";
import { Sidebar } from "@/components/Sidebar";
import { FloatingToolbar } from "@/components/canvas/FloatingToolbar";
import { NodeInspector } from "@/components/inspectors/NodeInspector";
import { SettingsPanel, KeyboardShortcutsPanel } from "@/components/panels";
import { QueuePanel } from "@/components/panels/QueuePanel";
import { ProviderPanel } from "@/components/panels/ProviderPanel";
import { StorageManagementModal } from "@/components/ui/StorageManagementModal";
import { ToastContainer } from "@/components/ui/Toast";
import { useCanvasStore } from "@/stores/canvasStore";
import { useFlowStore } from "@/stores/flowStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { initializeImageGenerationProviders } from "@/services/imageGeneration";
import { ensureAssetPathsAllowed, getStorageConfig } from "@/services/fileStorageService";
import { collectReferencedImagePaths } from "@/utils/imagePathRewrite";
import { installAssetImgSelfHeal } from "@/utils/assetImgSelfHeal";
import { sanitizeCanvasData } from "@/utils/canvasCompat";
import { useToastStore } from "@/stores/toastStore";

import "@/index.css";

// 初始化图片生成提供商
initializeImageGenerationProviders();

// asset 协议图片加载失败自愈（重启后授权竞态导致的破图）
installAssetImgSelfHeal();

function App() {
  // 细粒度 selector 订阅，避免不相关状态变化触发重渲染
  const activeCanvasId = useCanvasStore((s) => s.activeCanvasId);
  const getActiveCanvas = useCanvasStore((s) => s.getActiveCanvas);
  const createCanvas = useCanvasStore((s) => s.createCanvas);
  const canvases = useCanvasStore((s) => s.canvases);
  const _hasHydrated = useCanvasStore((s) => s._hasHydrated);
  // nodes/edges 不订阅到 React 状态——改用 store.subscribe 做数据同步
  // 避免每次节点变化都触发 App 重渲染（进而引发 Sidebar 等子树重渲染）
  const setNodes = useFlowStore((s) => s.setNodes);
  const setEdges = useFlowStore((s) => s.setEdges);
  const theme = useSettingsStore((state) => state.settings.theme);

  // 帮助面板状态
  const [isHelpOpen, setIsHelpOpen] = useState(false);

  // 用于追踪是否正在切换画布，避免循环更新
  const isLoadingCanvasRef = useRef(false);
  const prevCanvasIdRef = useRef<string | null>(null);

  // 应用主题到 HTML 元素
  useEffect(() => {
    const applyTheme = (themeName: string) => {
      if (themeName === "system") {
        // 跟随系统主题
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        document.documentElement.setAttribute("data-theme", prefersDark ? "dark" : "light");
      } else {
        document.documentElement.setAttribute("data-theme", themeName);
      }
    };

    applyTheme(theme);

    // 如果是跟随系统，监听系统主题变化
    if (theme === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const handleChange = (e: MediaQueryListEvent) => {
        document.documentElement.setAttribute("data-theme", e.matches ? "dark" : "light");
      };
      mediaQuery.addEventListener("change", handleChange);
      return () => mediaQuery.removeEventListener("change", handleChange);
    }
  }, [theme]);

  // 初始化：如果没有画布，创建一个默认画布
  // 重要：必须等待 hydration 完成后再检查，否则会覆盖存储中的数据
  useEffect(() => {
    if (_hasHydrated && canvases.length === 0) {
      createCanvas("默认画布");
    }
  }, [_hasHydrated, canvases.length, createCanvas]);

  // 重启后重新授予外部原图的 asset 协议访问权限。
  // Tauri 运行时的 asset scope 授权不持久化：画布引用的本地原图
  // （不在应用图片目录内的绝对路径）在重启后会失去访问权限，需重新 allow。
  useEffect(() => {
    if (!_hasHydrated) return;
    let cancelled = false;

    (async () => {
      try {
        const [config, referenced] = await Promise.all([
          getStorageConfig(),
          Promise.resolve(collectReferencedImagePaths()),
        ]);
        // 存储目录内的路径属于应用内部图片，无需重新授权
        const imagesRoot = (config.images_dir || "").trim().replace(/[\\/]+$/, "");
        const isInternal = (path: string) => {
          if (!imagesRoot) return false;
          const normalized = path.replace(/[\\/]+$/, "");
          if (!normalized.toLowerCase().startsWith(imagesRoot.toLowerCase())) return false;
          const rest = normalized.slice(imagesRoot.length);
          return rest === "" || rest.startsWith("\\") || rest.startsWith("/");
        };
        const externalPaths = referenced.filter((p) => !isInternal(p));
        if (!cancelled && externalPaths.length > 0) {
          await ensureAssetPathsAllowed(externalPaths);
        }
      } catch (err) {
        console.warn("恢复本地原图 asset 授权失败:", err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [_hasHydrated]);

  // 切换画布时：先保存旧画布数据，再加载新画布
  useEffect(() => {
    if (activeCanvasId && activeCanvasId !== prevCanvasIdRef.current) {
      // 切换前先将当前 flowStore 的数据同步到旧画布，避免防抖丢数据
      const prevId = prevCanvasIdRef.current;
      if (prevId) {
        const currentNodes = useFlowStore.getState().nodes;
        const currentEdges = useFlowStore.getState().edges;
        // 注意：此时 activeCanvasId 已经是新画布 ID，
        // 必须用 prevId 直接定位旧画布进行更新
        useCanvasStore.setState((state) => ({
          canvases: state.canvases.map((c) =>
            c.id === prevId
              ? { ...c, nodes: currentNodes, edges: currentEdges, updatedAt: Date.now() }
              : c
          ),
        }));
      }

      isLoadingCanvasRef.current = true;
      prevCanvasIdRef.current = activeCanvasId;

      const canvas = getActiveCanvas();
      if (canvas) {
        // 过滤旧版本画布中已移除的节点类型（视频 / PPT）
        const { nodes, edges, removedCount } = sanitizeCanvasData(canvas.nodes, canvas.edges);
        if (removedCount > 0) {
          useToastStore.getState().info(`已忽略 ${removedCount} 个旧版本节点（视频 / PPT 功能已移除）`);
          useCanvasStore.setState((state) => ({
            canvases: state.canvases.map((c) =>
              c.id === canvas.id ? { ...c, nodes, edges, updatedAt: Date.now() } : c
            ),
          }));
        }
        setNodes(nodes);
        setEdges(edges);
      }

      // 延迟重置标志，确保数据加载完成
      requestAnimationFrame(() => {
        isLoadingCanvasRef.current = false;
      });
    }
  }, [activeCanvasId, getActiveCanvas, setNodes, setEdges]);

  // 同步节点/边到画布存储：用 store.subscribe 替代 React effect+订阅
  // 好处：节点拖拽/编辑不触发 App 重渲染，只在后台防抖同步数据
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsubscribe = useFlowStore.subscribe((state, prevState) => {
      if (state.nodes === prevState.nodes && state.edges === prevState.edges) return;
      if (isLoadingCanvasRef.current) return;
      if (!useCanvasStore.getState().activeCanvasId) return;

      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const { nodes, edges } = useFlowStore.getState();
        useCanvasStore.getState().updateCanvasData(nodes, edges);
      }, 800);
    });

    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 监听 ? 键打开帮助面板
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault();
        setIsHelpOpen((prev) => !prev);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // 拖拽开始处理
  const onDragStart = useCallback(
    (
      event: React.DragEvent,
      nodeType: string,
      defaultData: Record<string, unknown>
    ) => {
      event.dataTransfer.setData("application/reactflow/type", nodeType);
      event.dataTransfer.setData(
        "application/reactflow/data",
        JSON.stringify(defaultData)
      );
      event.dataTransfer.effectAllowed = "move";
    },
    []
  );

  return (
    <ReactFlowProvider>
      <div className="nc-app-shell flex flex-col h-screen w-screen overflow-hidden">
        {/* 顶部标题条（无标题栏窗口的自定义标题栏） */}
        <Toolbar />

        {/* 主体内容 */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* 左侧导航栏（包含画布列表和节点库） */}
          <Sidebar onDragStart={onDragStart} onOpenHelp={() => setIsHelpOpen(true)} />

          {/* 右侧画布区域 */}
          <FlowCanvas />

          {/* 选中节点检查器 */}
          <NodeInspector />

          {/* 底部悬浮工具条（撤销/重做/运行/导入/导出/清空） */}
          <FloatingToolbar />
        </div>

        {/* 设置面板 */}
        <SettingsPanel />

        {/* 供应商管理面板 */}
        <ProviderPanel />

        {/* 快捷键帮助面板 */}
        <KeyboardShortcutsPanel isOpen={isHelpOpen} onClose={() => setIsHelpOpen(false)} />

        {/* 存储管理弹窗 */}
        <StorageManagementModal />

        {/* 生成队列面板 */}
        <QueuePanel />

        {/* Toast 通知容器 */}
        <ToastContainer />
      </div>
    </ReactFlowProvider>
  );
}

export default App;
