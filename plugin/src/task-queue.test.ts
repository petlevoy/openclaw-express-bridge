/**
 * Tests for task queue
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  enqueueTask,
  getPendingTasks,
  isHeavyTask,
  updateTaskStatus,
} from "./task-queue.js";

const QUEUE_FILE = path.join(
  os.homedir(),
  ".openclaw/agents/express/workspace/task-queue.json",
);

describe("Task Queue", () => {
  beforeEach(() => {
    // Clean up queue file before each test
    try {
      if (fs.existsSync(QUEUE_FILE)) {
        fs.unlinkSync(QUEUE_FILE);
      }
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    try {
      if (fs.existsSync(QUEUE_FILE)) {
        fs.unlinkSync(QUEUE_FILE);
      }
    } catch {
      // ignore
    }
  });

  describe("isHeavyTask", () => {
    it("should detect operative tasks", () => {
      expect(isHeavyTask("сделай оперативку на Иванова")).toBe(true);
    });

    it("should detect dossier tasks", () => {
      expect(isHeavyTask("собери досье на Петрова")).toBe(true);
    });

    it("should detect analysis tasks", () => {
      expect(isHeavyTask("сделай анализ компании")).toBe(true);
    });

    it("should detect search tasks", () => {
      expect(isHeavyTask("поищи информацию о конкурентах")).toBe(true);
    });

    it("should not flag simple messages", () => {
      expect(isHeavyTask("привет")).toBe(false);
      expect(isHeavyTask("как дела?")).toBe(false);
      expect(isHeavyTask("спасибо")).toBe(false);
    });
  });

  describe("enqueueTask", () => {
    it("should create a task with unique id", () => {
      const task = enqueueTask("chat-1", "user-1", "test text");
      expect(task.id).toMatch(/^task_\d+_/);
      expect(task.chatId).toBe("chat-1");
      expect(task.userId).toBe("user-1");
      expect(task.text).toBe("test text");
      expect(task.status).toBe("pending");
    });

    it("should persist task to file", () => {
      enqueueTask("chat-1", "user-1", "persisted task");
      const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
      expect(data).toHaveLength(1);
      expect(data[0].text).toBe("persisted task");
    });
  });

  describe("getPendingTasks", () => {
    it("should return only pending tasks", () => {
      const t1 = enqueueTask("chat-1", "user-1", "task 1");
      enqueueTask("chat-2", "user-2", "task 2");

      updateTaskStatus(t1.id, "processing");
      const pending = getPendingTasks();
      expect(pending).toHaveLength(1);
      expect(pending[0].text).toBe("task 2");
    });

    it("should return empty array when no tasks", () => {
      expect(getPendingTasks()).toEqual([]);
    });
  });

  describe("updateTaskStatus", () => {
    it("should update task status", () => {
      const task = enqueueTask("chat-1", "user-1", "test");
      updateTaskStatus(task.id, "done", "result text");
      const pending = getPendingTasks();
      expect(pending).toHaveLength(0);
    });

    it("should not fail for non-existent task", () => {
      expect(() => updateTaskStatus("nonexistent", "done")).not.toThrow();
    });
  });
});
