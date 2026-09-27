import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { tauriStorage } from "@/utils/tauriStorage";
import { executeImageGeneration } from "@/services/imageGenerationExecution";
import type { ImageGeneratorNodeData } from "@/components/nodes/imageGeneratorConfig";

export type QueueJobStatus = "queued" | "running" | "success" | "error" | "cancelled";

export interface QueueJob {
  id: string;
  nodeId: string;
  canvasId: string | null;
  /** 展示信息（入队时快照） */
  nodeLabel: string;
  modelLabel: string;
  promptPreview: string;
  status: QueueJobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /** 批量拆分序号（1 起），无批量时为 undefined */
  batchIndex?: number;
  batchTotal?: number;
  /** 批量拆分时的参数覆盖 */
  dataOverride?: Partial<ImageGeneratorNodeData>;
}

interface QueueState {
  jobs: QueueJob[];
  concurrency: number;
  paused: boolean;
  isQueuePanelOpen: boolean;

  enqueue: (job: Omit<QueueJob, "id" | "status" | "createdAt">) => string;
  cancel: (id: string) => void;
  retry: (id: string) => void;
  clearFinished: () => void;
  setConcurrency: (n: number) => void;
  togglePaused: () => void;
  setQueuePanelOpen: (open: boolean) => void;
  pump: () => void;
}

// 运行中的 AbortController（不持久化）
const abortControllers = new Map<string, AbortController>();
// 防止重入 pump
let pumping = false;

function createJobId() {
  return `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useQueueStore = create<QueueState>()(
  persist(
    (set, get) => ({
      jobs: [],
      concurrency: 2,
      paused: false,
      isQueuePanelOpen: false,

      enqueue: (job) => {
        const id = createJobId();
        const newJob: QueueJob = { ...job, id, status: "queued", createdAt: Date.now() };
        set((state) => ({
          jobs: [newJob, ...state.jobs].slice(0, 200),
        }));
        get().pump();
        return id;
      },

      cancel: (id) => {
        const job = get().jobs.find((j) => j.id === id);
        if (!job) return;

        if (job.status === "queued") {
          set((state) => ({
            jobs: state.jobs.map((j) =>
              j.id === id ? { ...j, status: "cancelled", finishedAt: Date.now() } : j
            ),
          }));
          // 同步取消同节点的排队状态
          updateNodeQueuedState(job.nodeId, job.canvasId, false);
        } else if (job.status === "running") {
          // 中断执行器：结果会被丢弃，节点恢复 idle
          abortControllers.get(id)?.abort();
        }
      },

      retry: (id) => {
        const job = get().jobs.find((j) => j.id === id);
        if (!job) return;
        get().enqueue({
          nodeId: job.nodeId,
          canvasId: job.canvasId,
          nodeLabel: job.nodeLabel,
          modelLabel: job.modelLabel,
          promptPreview: job.promptPreview,
          batchIndex: job.batchIndex,
          batchTotal: job.batchTotal,
          dataOverride: job.dataOverride,
        });
      },

      clearFinished: () => {
        set((state) => ({
          jobs: state.jobs.filter((j) => j.status === "queued" || j.status === "running"),
        }));
      },

      setConcurrency: (n) => {
        const clamped = Math.min(Math.max(Math.round(n), 1), 4);
        set({ concurrency: clamped });
        get().pump();
      },

      togglePaused: () => {
        set((state) => ({ paused: !state.paused }));
        get().pump();
      },

      setQueuePanelOpen: (open) => set({ isQueuePanelOpen: open }),

      pump: () => {
        if (pumping) return;
        pumping = true;

        const step = () => {
          const state = get();
          const runningCount = state.jobs.filter((j) => j.status === "running").length;
          if (state.paused || runningCount >= state.concurrency) {
            pumping = false;
            return;
          }

          const next = [...state.jobs]
            .reverse()
            .find((j) => j.status === "queued");
          if (!next) {
            pumping = false;
            return;
          }

          set((s) => ({
            jobs: s.jobs.map((j) =>
              j.id === next.id
                ? { ...j, status: "running", startedAt: Date.now(), error: undefined }
                : j
            ),
          }));

          const controller = new AbortController();
          abortControllers.set(next.id, controller);

          void executeImageGeneration(next.nodeId, {
            canvasId: next.canvasId,
            withRunRecords: true,
            signal: controller.signal,
            dataOverride: next.dataOverride,
          })
            .then((result) => {
              const finalStatus: QueueJobStatus = result.cancelled
                ? "cancelled"
                : result.success
                  ? "success"
                  : "error";
              set((s) => ({
                jobs: s.jobs.map((j) =>
                  j.id === next.id
                    ? {
                        ...j,
                        status: finalStatus,
                        finishedAt: Date.now(),
                        error: result.error,
                      }
                    : j
                ),
              }));
            })
            .catch((e) => {
              set((s) => ({
                jobs: s.jobs.map((j) =>
                  j.id === next.id
                    ? {
                        ...j,
                        status: "error",
                        finishedAt: Date.now(),
                        error: e instanceof Error ? e.message : String(e),
                      }
                    : j
                ),
              }));
            })
            .finally(() => {
              abortControllers.delete(next.id);
              step();
            });

          // 递归补位：并发未满时继续取下一个任务
          setTimeout(step, 0);
        };

        step();
      },
    }),
    {
      name: "generation-queue",
      storage: createJSONStorage(() => tauriStorage),
      partialize: (state) => ({
        jobs: state.jobs.filter((j) => j.status !== "running"),
        concurrency: state.concurrency,
      }),
      onRehydrateStorage: () => {
        return (state) => {
          if (!state) return;
          // 应用重启时，上次正在运行的任务已中断，标记为可重试的错误
          const interrupted = state.jobs.filter((j) => j.status === "running");
          if (interrupted.length > 0) {
            useQueueStore.setState({
              jobs: state.jobs.map((j) =>
                j.status === "running"
                  ? { ...j, status: "error", error: "应用重启导致中断，可重试", finishedAt: Date.now() }
                  : j
              ),
            });
          }
        };
      },
    }
  )
);

// 排队中/运行中时同步节点上的 queued 标记
function updateNodeQueuedState(nodeId: string, canvasId: string | null, queued: boolean) {
  import("@/stores/flowStore").then(({ useFlowStore }) => {
    useFlowStore.getState().updateNodeData<ImageGeneratorNodeData>(nodeId, { queued });
  });
  if (canvasId) {
    import("@/stores/canvasStore").then(({ useCanvasStore }) => {
      const { activeCanvasId, canvases } = useCanvasStore.getState();
      if (canvasId === activeCanvasId) return;
      useCanvasStore.setState({
        canvases: canvases.map((c) =>
          c.id === canvasId
            ? {
                ...c,
                nodes: c.nodes.map((n) =>
                  n.id === nodeId ? { ...n, data: { ...n.data, queued } } : n
                ),
              }
            : c
        ),
      });
    });
  }
}
