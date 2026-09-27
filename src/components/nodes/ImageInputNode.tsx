import { memo, useCallback, useRef, useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { ImagePlus, Upload, X, Maximize2, Paintbrush } from "lucide-react";
import { useFlowStore } from "@/stores/flowStore";
import { useCanvasStore } from "@/stores/canvasStore";
import { ImagePreviewModal } from "@/components/ui/ImagePreviewModal";
import { MaskEditorModal } from "@/components/ui/MaskEditorModal";
import {
  getImageUrl,
  saveImage,
  readImage,
  ensureAssetPathsAllowed,
  getFilePathForDroppedFile,
} from "@/services/fileStorageService";
import type { ImageInputNodeData } from "@/types";

// 定义节点类型
type ImageInputNode = Node<ImageInputNodeData>;

// 图片选择对话框支持的扩展名
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

// 从路径中提取文件名
function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// 图片输入节点
export const ImageInputNode = memo(({ id, data, selected }: NodeProps<ImageInputNode>) => {
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showMaskEditor, setShowMaskEditor] = useState(false);
  const isOverlay = data.__renderOverlay === true;

  // 路径优先导入：引用原始本地文件（零拷贝，不写入应用存储目录）。
  // base64 仅在内存中读取一份用于即时显示 / 蒙版绘制；持久化时 partialize 会剥离。
  const applyImageFromPath = useCallback(
    async (path: string, fileName?: string) => {
      try {
        await ensureAssetPathsAllowed([path]);
      } catch (err) {
        console.warn("扩展 asset 授权失败，图片可能无法预览:", err);
      }
      updateNodeData<ImageInputNodeData>(id, {
        imagePath: path,
        fileName: fileName || fileNameFromPath(path),
        imageData: undefined,
      });
      // 内存中的显示副本：读取失败不影响显示（显示走 asset 协议）
      try {
        const base64 = await readImage(path);
        // 防竞态：若用户已换图（imagePath 变化），丢弃过期数据
        const current = useFlowStore
          .getState()
          .nodes.find((n) => n.id === id)?.data as ImageInputNodeData | undefined;
        if (current?.imagePath === path) {
          updateNodeData<ImageInputNodeData>(id, { imageData: base64 });
        }
      } catch (err) {
        console.warn("读取图片显示副本失败:", err);
      }
    },
    [id, updateNodeData]
  );

  // 系统文件对话框选择：返回原图绝对路径，走零拷贝引用
  const handleOpenPicker = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "图片", extensions: IMAGE_EXTENSIONS }],
      });
      if (selected === null) return; // 用户取消
      if (typeof selected === "string" && selected) {
        await applyImageFromPath(selected);
        return;
      }
    } catch (err) {
      console.warn("打开系统文件对话框失败，回退到网页选择器:", err);
    }
    fileInputRef.current?.click();
  }, [applyImageFromPath]);

  // 网页选择器回退：WebView 通常拿不到绝对路径，
  // 此时保持零拷贝 —— base64 仅存内存，不再写入应用存储目录
  const handleFileSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      const realPath = getFilePathForDroppedFile(file);
      if (realPath) {
        await applyImageFromPath(realPath, file.name);
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        updateNodeData<ImageInputNodeData>(id, {
          imageData: base64,
          fileName: file.name,
          imagePath: undefined,
        });
      };
      reader.readAsDataURL(file);
    },
    [id, updateNodeData, applyImageFromPath]
  );

  const handleClearImage = useCallback(() => {
    updateNodeData<ImageInputNodeData>(id, {
      imageData: undefined,
      fileName: undefined,
      imagePath: undefined,
      maskImageData: undefined,
      maskImagePath: undefined,
      hasMask: undefined,
    });
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }, [id, updateNodeData]);

  const handleMaskSave = useCallback(
    async (maskBase64: string) => {
      const { activeCanvasId } = useCanvasStore.getState();
      if (activeCanvasId) {
        try {
          const maskInfo = await saveImage(
            maskBase64,
            activeCanvasId,
            id,
            undefined,
            undefined,
            "input"
          );
          updateNodeData<ImageInputNodeData>(id, {
            maskImageData: undefined,
            maskImagePath: maskInfo.path,
            hasMask: true,
          });
        } catch {
          updateNodeData<ImageInputNodeData>(id, {
            maskImageData: maskBase64,
            maskImagePath: undefined,
            hasMask: true,
          });
        }
      } else {
        updateNodeData<ImageInputNodeData>(id, {
          maskImageData: maskBase64,
          maskImagePath: undefined,
          hasMask: true,
        });
      }
    },
    [id, updateNodeData]
  );

  return (
  <>
    <div
      className={`
        nc-node-card nc-node-accent-green w-[200px] transition-all
        ${selected ? "nc-node-card-selected" : ""}
      `}
    >
      {/* 节点头部 */}
      <div className="nc-node-header nc-node-header-accent justify-start gap-2">
        <span className="nc-node-header-icon">
          <ImagePlus className="w-4 h-4" />
        </span>
        <span className="nc-node-title truncate">{data.label}</span>
      </div>

      {/* 节点内容 */}
      <div className="p-2 nodrag">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileSelect}
        />

        {data.imageData || data.imagePath ? (
          <div>
            {/* 图片预览 - 自适应高度展示完整图片 */}
            <div
              className="w-full overflow-hidden rounded-lg nc-soft-surface cursor-pointer group relative"
              onClick={() => setShowPreview(true)}
            >
              <img
                src={
                  data.imagePath
                    ? getImageUrl(data.imagePath)
                    : data.imageData
                    ? `data:image/png;base64,${data.imageData}`
                    : ""
                }
                alt="Input"
                className="w-full h-auto block"
              />
              {/* 蒙版叠加层 - 直接显示红色标记 */}
              {data.hasMask && (data.maskImagePath || data.maskImageData) && (
                <img
                  src={
                    data.maskImagePath
                      ? getImageUrl(data.maskImagePath)
                      : `data:image/png;base64,${data.maskImageData}`
                  }
                  alt=""
                  className="absolute inset-0 w-full h-full pointer-events-none"
                />
              )}
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center">
                <Maximize2 className="w-6 h-6 text-white" />
              </div>
            </div>
            {/* 操作栏 */}
            <div className="flex items-center mt-1.5 gap-1">
              {data.fileName && (
                <p className="text-[11px] text-base-content/60 truncate flex-1">
                  {data.fileName}
                </p>
              )}
              <div className="flex items-center gap-0.5 ml-auto flex-shrink-0">
                <button
                  className={data.hasMask ? "btn btn-circle btn-xs btn-error" : "nc-icon-btn nc-icon-btn-xs"}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowMaskEditor(true);
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  title={data.hasMask ? "编辑蒙版（已设置）" : "添加蒙版"}
                >
                  <Paintbrush className="w-3 h-3" />
                </button>
                <button
                  className="nc-icon-btn nc-icon-btn-xs nc-icon-btn-danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClearImage();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  title="删除图片"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <button
            className="btn btn-ghost w-full h-[120px] rounded-[var(--nc-radius-md)] border border-dashed border-base-300 hover:border-primary flex-col gap-1"
            onClick={handleOpenPicker}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <Upload className="w-6 h-6 text-base-content/40" />
            <span className="text-[11px] text-base-content/60">点击上传图片</span>
          </button>
        )}
      </div>

      {!isOverlay && (
        <Handle
          type="source"
          position={Position.Right}
          id="output-image"
          className="!w-3 !h-3 !bg-green-500 !border-2 !border-white"
        />
      )}
    </div>

    {/* 预览弹窗 */}
    {showPreview && (data.imageData || data.imagePath) && (
      <ImagePreviewModal
        imageData={data.imageData}
        imagePath={data.imagePath}
        onClose={() => setShowPreview(false)}
        fileName={data.fileName}
      />
    )}

    {/* 蒙版编辑器 */}
    {showMaskEditor && (data.imageData || data.imagePath) && (
      <MaskEditorModal
        imageUrl={
          data.imagePath
            ? getImageUrl(data.imagePath)
            : `data:image/png;base64,${data.imageData}`
        }
        existingMaskData={data.maskImageData}
        existingMaskPath={data.maskImagePath}
        onSave={handleMaskSave}
        onClose={() => setShowMaskEditor(false)}
      />
    )}
  </>
  );
});

ImageInputNode.displayName = "ImageInputNode";
