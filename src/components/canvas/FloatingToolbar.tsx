/**
 * 底部悬浮工具条：原顶部中央的工作流操作（撤销/重做/运行/导入/导出/清空）
 * 悬浮在客户端底部居中、略高于底边的位置，不占用画布空间。
 */
import { useState } from "react";
import { Trash2, Download, Upload, Undo2, Redo2 } from "lucide-react";
import { useFlowStore } from "@/stores/flowStore";
import { toast } from "@/stores/toastStore";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WorkflowControls } from "@/components/workflow/WorkflowControls";

export function FloatingToolbar() {
  const clearCanvas = useFlowStore((state) => state.clearCanvas);
  const setNodes = useFlowStore((state) => state.setNodes);
  const setEdges = useFlowStore((state) => state.setEdges);
  const undo = useFlowStore((state) => state.undo);
  const redo = useFlowStore((state) => state.redo);
  const canUndo = useFlowStore((state) => state.canUndo);
  const canRedo = useFlowStore((state) => state.canRedo);

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
    <>
      <div className="nc-floating-toolbar">
        <div className="tooltip tooltip-top" data-tip={`撤销 (${cmdKey}+Z)`}>
          <button
            className="nc-icon-btn"
            onClick={undo}
            disabled={!canUndo()}
            aria-label="撤销"
          >
            <Undo2 className="w-4 h-4" />
          </button>
        </div>
        <div className="tooltip tooltip-top" data-tip={`重做 (${cmdKey}+Shift+Z)`}>
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

        {/* 工作流控制（运行全部 / 暂停 / 停止） */}
        <WorkflowControls />
        <div className="nc-divider-v" />

        <div className="tooltip tooltip-top" data-tip="导入工作流">
          <button className="btn btn-ghost btn-sm gap-2" onClick={handleImport} aria-label="导入工作流">
            <Upload className="w-4 h-4" />
            导入
          </button>
        </div>
        <div className="tooltip tooltip-top" data-tip="导出工作流">
          <button className="btn btn-ghost btn-sm gap-2" onClick={handleExport} aria-label="导出工作流">
            <Download className="w-4 h-4" />
            导出
          </button>
        </div>
        <div className="nc-divider-v" />
        <div className="tooltip tooltip-top" data-tip="清空画布">
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
    </>
  );
}
