// src/utils/processManager.ts
import { ChildProcess } from 'child_process';

/**
 * Global in-memory map to track and manage actively running Python child processes.
 * Shares reference sockets between your API routers and the daemon worker.
 */
export const activeProcesses = new Map<string, ChildProcess>();