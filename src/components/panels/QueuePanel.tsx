import { useMemo } from "react";
import { createPortal } from "react-dom";
import {
  X,
  ListTodo,
  Trash2,
  RotateCcw,
  Pause,
  Play,
  CircleAlert,
  CheckCircle2,
  Loader2,
  Clock3,
  Ban,
} from "lucide-react";
import { useQueueStore, type QueueJob } from "@/stores/queueStore";

function getStatusIcon(status: QueueJob["status"]) {
  switch (status) {
    case "queued":
      return <Clock3 className="h-3.5 w-3.5 flex-shrink-0 text-base-content/40" />;
    case "running":
      return <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-info" />;
    case "success":
      return <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0 text-success" />;
    case "error":
      return <CircleAlert className="h-3.5 w-3.5 flex-shrink-0 text-error" />;
    default:
      return <Ban className="h-3.5 w-3.5 flex-shrink-0 text-base-content/40" />;
  }
}

function getStatusLabel(job: QueueJob) {
  switch (job.status) {
    case "queued":
      return "排队中";
    case "running":
      return "生成中";
    case "success":
      return "已完成";
    case "error":
      return job.error || "失败";
    default:
      return "已取消";
  }
}

function formatDuration(job: QueueJob) {
  if (!job.startedAt) return "";
  const end = job.finishedAt || Date.now();
  const ms = end - job.startedAt;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function QueuePanel() {
  const jobs = useQueueStore((s) => s.jobs);
  const concurrency = useQueueStore((s) => s.concurrency);
  const paused = useQueueStore((s) => s.paused);
  const isOpen = useQueueStore((s) => s.isQueuePanelOpen);
  const cancel = useQueueStore((s) => s.cancel);
  const retry = useQueueStore((s) => s.retry);
  const clearFinished = useQueueStore((s) => s.clearFinished);
  const setConcurrency = useQueueStore((s) => s.setConcurrency);
  const togglePaused = useQueueStore((s) => s.togglePaused);
  const setQueuePanelOpen = useQueueStore((s) => s.setQueuePanelOpen);

  const counts = useMemo(() => {
    let queued = 0;
    let running = 0;
    for (const job of jobs) {
      if (job.status === "queued") queued++;
      else if (job.status === "running") running++;
    }
    return { queued, running };
  }, [jobs]);

  const sortedJobs = useMemo(
    () =>
      [...jobs].sort((a, b) => {
        // 进行中的在前，其余按创建时间倒序
        const active = (s: QueueJob["status"]) => (s === "running" ? 0 : s === "queued" ? 1 : 2);
        const diff = active(a.status) - active(b.status);
        return diff !== 0 ? diff : b.createdAt - a.createdAt;
      }),
    [jobs]
  );

  if (!isOpen) return null;

  return createPortal(
    <div
      className="nc-panel-lg fixed bottom-4 right-4 z-[60] w-[340px] overflow-hidden shadow-[var(--nc-shadow-deep)]!"
    >
      {/* 头部 */}
      <div className="flex items-center gap-2 border-b border-base-300 bg-base-200/50 px-3.5 py-2.5">
        <div className="nc-node-header-icon">
          <ListTodo className="h-3.5 w-3.5" />
        </div>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">
          生成队列
          {counts.running + counts.queued > 0 && (
            <span className="ml-2 text-xs font-normal nc-muted">
              {counts.running > 0 && `${counts.running} 进行中`}
              {counts.running > 0 && counts.queued > 0 && " · "}
              {counts.queued > 0 && `${counts.queued} 排队`}
            </span>
          )}
        </span>
        <div className="tooltip tooltip-left" data-tip={paused ? "恢复队列" : "暂停队列"}>
          <button
            type="button"
            className="nc-icon-btn nc-icon-btn-xs"
            onClick={togglePaused}
            aria-label={paused ? "恢复队列" : "暂停队列"}
          >
            {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
        </div>
        <div className="tooltip tooltip-left" data-tip="清除已完成任务">
          <button
            type="button"
            className="nc-icon-btn nc-icon-btn-xs"
            onClick={clearFinished}
            aria-label="清除已完成任务"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="tooltip tooltip-left" data-tip="关闭">
          <button
            type="button"
            className="nc-icon-btn nc-icon-btn-xs"
            onClick={() => setQueuePanelOpen(false)}
            aria-label="关闭"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* 并发设置 */}
      <div className="flex items-center gap-2 border-b border-base-300/70 px-3.5 py-2">
        <span className="text-xs nc-muted">并发数</span>
        <div className="flex gap-1">
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              className={`nc-stepper-btn ${concurrency === n ? "nc-stepper-btn-active" : ""}`}
              onClick={() => setConcurrency(n)}
            >
              {n}
            </button>
          ))}
        </div>
        {paused && (
          <span className="nc-chip nc-chip-warning ml-auto">
            队列已暂停
          </span>
        )}
      </div>

      {/* 任务列表 */}
      <div className="nc-scrollbar-none max-h-[320px] overflow-y-auto">
        {sortedJobs.length === 0 ? (
          <div className="nc-empty-state">
            <ListTodo className="h-8 w-8 opacity-40" />
            <p className="nc-empty-state-title">暂无任务</p>
            <p className="nc-empty-state-hint">点击节点上的生成按钮开始</p>
          </div>
        ) : (
          <div className="divide-y divide-base-300/60">
            {sortedJobs.map((job) => (
              <div key={job.id} className="flex items-start gap-2 px-3 py-2.5 hover:bg-base-200/40">
                <div className="mt-0.5">{getStatusIcon(job.status)}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {job.nodeLabel}
                      {job.batchTotal && job.batchTotal > 1 && (
                        <span className="ml-1 text-base-content/45">
                          {job.batchIndex}/{job.batchTotal}
                        </span>
                      )}
                    </span>
                    <span className="flex-shrink-0 text-[11px] text-base-content/40">
                      {formatDuration(job)}
                    </span>
                  </div>
                  {job.promptPreview && (
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-base-content/45">
                      {job.promptPreview}
                    </div>
                  )}
                  {(job.status === "error" || job.status === "cancelled") && (
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-error/80">
                      {getStatusLabel(job)}
                    </div>
                  )}
                  <div className="mt-0.5 text-[11px] text-base-content/35">
                    {job.modelLabel}
                  </div>
                </div>
                <div className="flex flex-shrink-0 items-center gap-0.5">
                  {(job.status === "queued" || job.status === "running") && (
                    <div className="tooltip tooltip-left" data-tip="取消">
                      <button
                        type="button"
                        className="nc-icon-btn nc-icon-btn-xs nc-icon-btn-danger"
                        onClick={() => cancel(job.id)}
                      >
                        <Ban className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {(job.status === "error" || job.status === "cancelled") && (
                    <div className="tooltip tooltip-left" data-tip="重新排队">
                      <button
                        type="button"
                        className="nc-icon-btn nc-icon-btn-xs hover:text-primary!"
                        onClick={() => retry(job.id)}
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
