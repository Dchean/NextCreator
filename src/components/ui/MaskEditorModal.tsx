import { useState, useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Paintbrush, Eraser, Undo2, Trash2, Save, Minus, Plus } from "lucide-react";
import { useModal } from "@/hooks/useModal";
import { getImageUrl } from "@/services/fileStorageService";

interface MaskEditorModalProps {
  imageUrl: string;
  existingMaskData?: string;
  existingMaskPath?: string;
  onSave: (maskBase64: string) => void;
  onClose: () => void;
}

export function MaskEditorModal({
  imageUrl,
  existingMaskData,
  existingMaskPath,
  onSave,
  onClose,
}: MaskEditorModalProps) {
  const [brushSize, setBrushSize] = useState(30);
  const [isEraser, setIsEraser] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const bgCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const displayScaleRef = useRef(1);

  // 计算已有蒙版的 URL
  const existingMaskUrl = existingMaskPath
    ? getImageUrl(existingMaskPath)
    : existingMaskData
    ? `data:image/png;base64,${existingMaskData}`
    : null;

  // 统一 Modal 交互（ESC 关闭、背景点击、过渡动画）
  const { isVisible, isClosing, handleClose } = useModal({
    isOpen: true,
    onClose,
  });

  // 加载图片并初始化 canvas
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageRef.current = img;
      setupCanvases(img);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const setupCanvases = useCallback((img: HTMLImageElement) => {
    const container = canvasContainerRef.current;
    const bgCanvas = bgCanvasRef.current;
    const drawCanvas = drawCanvasRef.current;
    if (!container || !bgCanvas || !drawCanvas) return;

    const natW = img.naturalWidth;
    const natH = img.naturalHeight;

    // 计算适配视口的显示尺寸（留 padding）
    const maxW = window.innerWidth - 160;
    const maxH = window.innerHeight - 160;
    const scale = Math.min(maxW / natW, maxH / natH, 1);
    displayScaleRef.current = scale;

    const displayW = Math.round(natW * scale);
    const displayH = Math.round(natH * scale);

    // 设置 canvas 的实际像素尺寸为原图分辨率
    bgCanvas.width = natW;
    bgCanvas.height = natH;
    drawCanvas.width = natW;
    drawCanvas.height = natH;

    // CSS 显示尺寸
    bgCanvas.style.width = `${displayW}px`;
    bgCanvas.style.height = `${displayH}px`;
    drawCanvas.style.width = `${displayW}px`;
    drawCanvas.style.height = `${displayH}px`;
    container.style.width = `${displayW}px`;
    container.style.height = `${displayH}px`;

    // 绘制背景图
    const bgCtx = bgCanvas.getContext("2d")!;
    bgCtx.drawImage(img, 0, 0, natW, natH);

    // 如果有已保存的蒙版绘制层，直接加载恢复
    if (existingMaskUrl) {
      const maskImg = new Image();
      maskImg.crossOrigin = "anonymous";
      maskImg.onload = () => {
        const drawCtx = drawCanvas.getContext("2d")!;
        drawCtx.drawImage(maskImg, 0, 0, natW, natH);
        pushUndo();
        setHasChanges(true);
      };
      maskImg.src = existingMaskUrl;
    }
  }, [existingMaskUrl]);

  // 保存撤销快照
  const pushUndo = useCallback(() => {
    const drawCanvas = drawCanvasRef.current;
    if (!drawCanvas) return;
    const ctx = drawCanvas.getContext("2d")!;
    const imageData = ctx.getImageData(0, 0, drawCanvas.width, drawCanvas.height);
    const stack = undoStackRef.current;
    if (stack.length >= 20) stack.shift();
    stack.push(imageData);
  }, []);

  // 撤销
  const handleUndo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length <= 0) return;
    stack.pop(); // 移除当前状态
    const drawCanvas = drawCanvasRef.current;
    if (!drawCanvas) return;
    const ctx = drawCanvas.getContext("2d")!;
    if (stack.length > 0) {
      ctx.putImageData(stack[stack.length - 1], 0, 0);
    } else {
      ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    }
    setHasChanges(stack.length > 0);
  }, []);

  // 清除全部
  const handleClear = useCallback(() => {
    const drawCanvas = drawCanvasRef.current;
    if (!drawCanvas) return;
    const ctx = drawCanvas.getContext("2d")!;
    ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
    undoStackRef.current = [];
    setHasChanges(false);
  }, []);

  // 将屏幕坐标转换为 canvas 坐标
  const getCanvasPoint = useCallback((e: React.PointerEvent) => {
    const drawCanvas = drawCanvasRef.current;
    if (!drawCanvas) return { x: 0, y: 0 };
    const rect = drawCanvas.getBoundingClientRect();
    const scale = displayScaleRef.current;
    return {
      x: (e.clientX - rect.left) / scale,
      y: (e.clientY - rect.top) / scale,
    };
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      setIsDrawing(true);
      const point = getCanvasPoint(e);
      lastPointRef.current = point;

      const drawCanvas = drawCanvasRef.current;
      if (!drawCanvas) return;
      const ctx = drawCanvas.getContext("2d")!;

      ctx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
      ctx.strokeStyle = "rgba(255, 0, 0, 0.5)";
      ctx.lineWidth = brushSize / displayScaleRef.current;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // 画一个点
      ctx.beginPath();
      ctx.arc(point.x, point.y, (brushSize / displayScaleRef.current) / 2, 0, Math.PI * 2);
      ctx.fillStyle = isEraser ? "rgba(0,0,0,1)" : "rgba(255, 0, 0, 0.5)";
      if (isEraser) {
        ctx.globalCompositeOperation = "destination-out";
      }
      ctx.fill();

      drawCanvas.setPointerCapture(e.pointerId);
    },
    [brushSize, isEraser, getCanvasPoint]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawing) return;
      const point = getCanvasPoint(e);
      const last = lastPointRef.current;
      if (!last) return;

      const drawCanvas = drawCanvasRef.current;
      if (!drawCanvas) return;
      const ctx = drawCanvas.getContext("2d")!;

      ctx.globalCompositeOperation = isEraser ? "destination-out" : "source-over";
      ctx.strokeStyle = "rgba(255, 0, 0, 0.5)";
      ctx.lineWidth = brushSize / displayScaleRef.current;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();

      lastPointRef.current = point;
    },
    [isDrawing, brushSize, isEraser, getCanvasPoint]
  );

  const handlePointerUp = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);
    lastPointRef.current = null;
    pushUndo();
    setHasChanges(true);
  }, [isDrawing, pushUndo]);

  // 保存蒙版 - 只导出绘制层（红色标记，透明背景）
  const handleSave = useCallback(() => {
    const drawCanvas = drawCanvasRef.current;
    if (!drawCanvas) return;

    const dataUrl = drawCanvas.toDataURL("image/png");
    const base64 = dataUrl.split(",")[1];
    onSave(base64);

    handleClose();
  }, [onSave, handleClose]);

  // 画笔大小调整
  const adjustBrushSize = useCallback((delta: number) => {
    setBrushSize((s) => Math.max(5, Math.min(100, s + delta)));
  }, []);

  return createPortal(
    <div
      className={`
        nc-modal-backdrop nc-modal-backdrop-deep
        transition-all duration-200 ease-out
        ${isVisible && !isClosing ? "opacity-100" : "opacity-0"}
      `}
      onClick={handleClose}
    >
      {/* Canvas 容器 */}
      <div
        ref={canvasContainerRef}
        className={`
          relative transition-all duration-200 ease-out
          ${isVisible && !isClosing ? "opacity-100 scale-100" : "opacity-0 scale-95"}
        `}
        onClick={(e) => e.stopPropagation()}
        style={{ cursor: isEraser ? "crosshair" : "crosshair" }}
      >
        {/* 背景 canvas - 原图 */}
        <canvas
          ref={bgCanvasRef}
          className="absolute inset-0 rounded-lg"
          style={{ imageRendering: "auto" }}
        />
        {/* 绘制 canvas - 蒙版层 */}
        <canvas
          ref={drawCanvasRef}
          className="absolute inset-0 rounded-lg"
          style={{ imageRendering: "auto" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        />

        {/* 棋盘格背景指示透明区 */}
        <div className="absolute inset-0 rounded-lg -z-10 bg-base-300" />
      </div>

      {/* 顶部工具栏 */}
      <div
        className={`
          absolute top-4 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2
          bg-base-100/95 backdrop-blur-sm rounded-[var(--nc-radius-lg)] px-4 py-2.5
          transition-all duration-200 ease-out
          ${isVisible && !isClosing ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-4"}
        `}
        style={{ boxShadow: "var(--nc-shadow-deep)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 画笔/橡皮切换 */}
        <div className="flex items-center gap-1 border-r border-base-300 pr-3">
          <button
            className={`btn btn-sm btn-circle ${!isEraser ? "btn-error" : "btn-ghost"}`}
            onClick={() => setIsEraser(false)}
            title="画笔"
          >
            <Paintbrush className="w-4 h-4" />
          </button>
          <button
            className={`btn btn-sm btn-circle ${isEraser ? "btn-warning" : "btn-ghost"}`}
            onClick={() => setIsEraser(true)}
            title="橡皮擦"
          >
            <Eraser className="w-4 h-4" />
          </button>
        </div>

        {/* 画笔大小 */}
        <div className="flex items-center gap-2 border-r border-base-300 pr-3">
          <button
            className="btn btn-xs btn-ghost btn-circle"
            onClick={() => adjustBrushSize(-5)}
          >
            <Minus className="w-3 h-3" />
          </button>
          <div className="flex items-center gap-1.5 min-w-[80px] justify-center">
            <div
              className="rounded-full bg-error/60 flex-shrink-0"
              style={{
                width: `${Math.max(4, brushSize * 0.4)}px`,
                height: `${Math.max(4, brushSize * 0.4)}px`,
              }}
            />
            <span className="text-xs text-base-content/70 min-w-[24px] text-center">
              {brushSize}
            </span>
          </div>
          <button
            className="btn btn-xs btn-ghost btn-circle"
            onClick={() => adjustBrushSize(5)}
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1 border-r border-base-300 pr-3">
          <button
            className="btn btn-sm btn-ghost gap-1"
            onClick={handleUndo}
            title="撤销"
          >
            <Undo2 className="w-4 h-4" />
            <span className="text-xs">撤销</span>
          </button>
          <button
            className="btn btn-sm btn-ghost gap-1"
            onClick={handleClear}
            title="清除全部"
          >
            <Trash2 className="w-4 h-4" />
            <span className="text-xs">清除</span>
          </button>
        </div>

        {/* 保存/关闭 */}
        <div className="flex items-center gap-1">
          <button
            className={`btn btn-sm gap-1 ${hasChanges ? "btn-success" : "btn-disabled"}`}
            onClick={handleSave}
            disabled={!hasChanges}
            title="保存蒙版"
          >
            <Save className="w-4 h-4" />
            <span className="text-xs">保存</span>
          </button>
          <button
            className="btn btn-sm btn-ghost btn-circle"
            onClick={handleClose}
            title="取消"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 底部提示 */}
      <div
        className={`
          absolute bottom-4 left-1/2 -translate-x-1/2 text-white/60 text-sm
          transition-all duration-200 ease-out
          ${isVisible && !isClosing ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"}
        `}
      >
        在图片上涂画标记想要编辑的区域 · 按 ESC 关闭
      </div>
    </div>,
    document.body
  );
}
