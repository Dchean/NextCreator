import { useState } from "react";
import { Settings, Trash2, Download, Upload, Undo2, Redo2, HelpCircle, Server, HardDrive, ListTodo } from "lucide-react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useFlowStore } from "@/stores/flowStore";
import { useStorageManagementStore } from "@/stores/storageManagementStore";
import { useQueueStore } from "@/stores/queueStore";
import { toast } from "@/stores/toastStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WorkflowControls } from "@/components/workflow/WorkflowControls";
import logoImage from "@/assets/logo.png";
// 版本号单一来源：package.json（Vite 构建时会把整包内联，运行时无网络请求）。
// 此前这里是写死的字符串，版本升级时极易漏改（画布内长期显示旧版本号）。
import packageJson from "../../package.json";

export function Toolbar({ onOpenHelp }: { onOpenHelp?: () => void }) {
  const { openSettings, openProviderPanel } = useSettingsStore();
  const clearCanvas = useFlowStore((state) => state.clearCanvas);
  const setNodes = useFlowStore((state) => state.setNodes);
  const setEdges = useFlowStore((state) => state.setEdges);
  const undo = useFlowStore((state) => state.undo);
  const redo = useFlowStore((state) => state.redo);
  const canUndo = useFlowStore((state) => state.canUndo);
  const canRedo = useFlowStore((state) => state.canRedo);
  const { openModal: openStorageModal } = useStorageManagementStore();
  const isQueuePanelOpen = useQueueStore((s) => s.isQueuePanelOpen);
  const setQueuePanelOpen = useQueueStore((s) => s.setQueuePanelOpen);
  const activeCount = useQueueStore(
    (s) => s.jobs.filter((j) => j.status === "queued" || j.status === "running").length
  );

  // 清空画布确认对话框状态
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const handleClearCanvas = () => {
    clearCanvas();
    setShowClearConfirm(false);
  };

  // 清理节点数据中的 base64 图片，仅保留文件路径
  const cleanNodeDataForExport = (nodes: ReturnType<typeof useFlowStore.getState>["nodes"]) => {
    return nodes.map((node) => {
      const cleanedNode = { ...node, data: { ...node.data } };
      const data = cleanedNode.data;

      // 清理 ImageInputNode 的 base64 数据
      if ("imageData" in data && "imagePath" in data) {
        delete data.imageData;
      }

      // 清理 ImageGeneratorNode 的 base64 数据
      if ("outputImage" in data && "outputImagePath" in data) {
        delete data.outputImage;
      }

      return cleanedNode;
    });
  };

  // 导出工作流
  const handleExport = async () => {
    const { nodes, edges } = useFlowStore.getState();
    const cleanedNodes = cleanNodeDataForExport(nodes);
    const data = { nodes: cleanedNodes, edges };
    const jsonStr = JSON.stringify(data, null, 2);
    const fileName = `next-workflow-${Date.now()}.json`;

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");

      const filePath = await save({
        defaultPath: fileName,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });

      if (filePath) {
        await writeTextFile(filePath, jsonStr);
        toast.success(`工作流已保存到: ${filePath.split("/").pop()}`);
      }
    } catch (error) {
      console.error("导出工作流失败:", error);
      toast.error(`导出失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  // 导入工作流
  const handleImport = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");

      const filePath = await open({
        filters: [{ name: "JSON", extensions: ["json"] }],
        multiple: false,
      });

      if (filePath && typeof filePath === "string") {
        const content = await readTextFile(filePath);
        const data = JSON.parse(content);
        if (data.nodes && data.edges) {
          setNodes(data.nodes);
          setEdges(data.edges);
          toast.success("工作流导入成功");
        } else {
          toast.error("无效的工作流文件");
        }
      }
    } catch (error) {
      console.error("导入工作流失败:", error);
      toast.error(`导入失败: ${error instanceof Error ? error.message : "未知错误"}`);
    }
  };

  const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().indexOf("MAC") >= 0;
  const cmdKey = isMac ? "⌘" : "Ctrl";

  return (
    <div className="nc-toolbar flex items-center justify-between px-4">
      {/* 左侧 Logo */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <img src={logoImage} alt="NextCreator" className="w-8 h-8 rounded-md" />
          <span className="text-base font-bold leading-none">NextCreator</span>
        </div>
        <div className="nc-badge">v{packageJson.version}</div>
      </div>

      {/* 中间工具 */}
      <div className="nc-toolbar-group">
        {/* 撤销/重做 */}
        <div className="tooltip tooltip-bottom" data-tip={`撤销 (${cmdKey}+Z)`}>
          <button
            className="nc-icon-btn"
            onClick={undo}
            disabled={!canUndo()}
            aria-label="撤销"
          >
            <Undo2 className="w-4 h-4" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip={`重做 (${cmdKey}+Shift+Z)`}>
          <button
            className="nc-icon-btn"
            onClick={redo}
            disabled={!canRedo()}
            aria-label="重做"
          >
            <Redo2 className="w-4 h-4" />
          </button>
        </div>
        <div className="nc-divider-v" />

        {/* 工作流控制 */}
        <WorkflowControls />
        <div className="nc-divider-v" />

        <div className="tooltip tooltip-bottom" data-tip="导入工作流">
          <button className="btn btn-ghost btn-sm gap-2" onClick={handleImport} aria-label="导入工作流">
            <Upload className="w-4 h-4" />
            导入
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="导出工作流">
          <button className="btn btn-ghost btn-sm gap-2" onClick={handleExport} aria-label="导出工作流">
            <Download className="w-4 h-4" />
            导出
          </button>
        </div>
        <div className="nc-divider-v" />
        <div className="tooltip tooltip-bottom" data-tip="清空画布">
          <button
            className="btn btn-ghost btn-sm text-error gap-2"
            onClick={() => setShowClearConfirm(true)}
            aria-label="清空画布"
          >
            <Trash2 className="w-4 h-4" />
            清空
          </button>
        </div>
      </div>

      {/* 右侧设置 */}
      <div className="flex items-center gap-1 rounded-lg border border-transparent bg-base-100/40 p-1">
        <div className="tooltip tooltip-bottom" data-tip="生成队列">
          <button
            className="nc-icon-btn relative"
            onClick={() => setQueuePanelOpen(!isQueuePanelOpen)}
            aria-label="生成队列"
          >
            <ListTodo className="w-4 h-4" />
            {activeCount > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-medium leading-none text-primary-content">
                {activeCount}
              </span>
            )}
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="存储管理">
          <button className="nc-icon-btn" onClick={openStorageModal} aria-label="存储管理">
            <HardDrive className="w-4 h-4" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="供应商管理">
          <button className="nc-icon-btn" onClick={openProviderPanel} aria-label="供应商管理">
            <Server className="w-4 h-4" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="帮助 (?)">
          <button className="nc-icon-btn" onClick={onOpenHelp} aria-label="帮助">
            <HelpCircle className="w-4 h-4" />
          </button>
        </div>
        <div className="tooltip tooltip-bottom" data-tip="设置">
          <button className="nc-icon-btn" onClick={openSettings} aria-label="设置">
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 清空画布确认对话框 */}
      {showClearConfirm && (
        <ConfirmDialog
          tone="error"
          title="确认清空"
          message="确定要清空画布吗？这将删除画布上的所有节点和连线，此操作不可撤销。"
          confirmText="确认清空"
          onConfirm={handleClearCanvas}
          onClose={() => setShowClearConfirm(false)}
        />
      )}
    </div>
  );
}
