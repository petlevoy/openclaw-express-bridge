/**
 * Task Queue for eXpress — heavy tasks are enqueued to avoid blocking the webhook.
 * The main agent processes the queue and delivers results.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const QUEUE_FILE = path.join(
  os.homedir(),
  ".openclaw/agents/express/workspace/task-queue.json",
);

export interface QueuedTask {
  id: string;
  createdAt: number;
  chatId: string;
  userId: string;
  text: string;
  status: "pending" | "processing" | "done" | "failed";
  result?: string;
}

// Patterns for heavy tasks — anything requiring exec/search/files
const HEAVY_TASK_PATTERNS = [
  /оперативк/i,
  /досье/i,
  /справк/i,
  /docx|word/i,
  /найди.*информацию/i,
  /собери.*данн/i,
  /сделай.*документ/i,
  /сделай.*файл/i,
  /сделай.*про\s/i,
  /файл.*про\s/i,
  /исследование/i,
  /анализ/i,
  /дайджест/i,
  /собери.*информац/i,
  /найди.*про\s/i,
  /расскажи.*подробно/i,
  /пробей/i,
  /узнай.*все\s/i,
  /поищи/i,
  /загрузи/i,
  /скачай/i,
];

export function isHeavyTask(text: string): boolean {
  return HEAVY_TASK_PATTERNS.some((p) => p.test(text));
}

function readQueue(): QueuedTask[] {
  try {
    if (!fs.existsSync(QUEUE_FILE)) return [];
    return JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function writeQueue(tasks: QueuedTask[]): void {
  fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(tasks, null, 2));
}

export function enqueueTask(
  chatId: string,
  userId: string,
  text: string,
): QueuedTask {
  const tasks = readQueue();
  const task: QueuedTask = {
    id: `task_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    chatId,
    userId,
    text,
    status: "pending",
  };
  tasks.push(task);
  writeQueue(tasks);
  return task;
}

export function getPendingTasks(): QueuedTask[] {
  return readQueue().filter((t) => t.status === "pending");
}

export function updateTaskStatus(
  id: string,
  status: QueuedTask["status"],
  result?: string,
): void {
  const tasks = readQueue();
  const task = tasks.find((t) => t.id === id);
  if (task) {
    task.status = status;
    if (result) task.result = result;
    writeQueue(tasks);
  }
}
