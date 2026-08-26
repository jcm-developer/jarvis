import type { ToolSchema } from '../llm/provider';
import type { Env } from '../types';
import { findFreeSlots, whatNow } from './agenda';
import { deleteBook, listBooks, logBook } from './books';
import { createEvent, deleteEvent, listEvents, updateEvent } from './calendar';
import { recall, remember } from './memory';
import { deleteProject, listProjects, saveProject } from './projects';
import { readUrl, searchWeb } from './search';
import { completeTask, createTask, deleteTask, listTasks, updateTask } from './tasks';
import type { ToolDefinition } from './types';

/**
 * The tool catalogue.
 *
 * This is the agent's "instruction manual", except it takes the shape of JSON Schema
 * in the request's `tools` field rather than prose inside the prompt. The model gets
 * typed signatures instead of a description it has to interpret.
 */
export const TOOLS: ToolDefinition[] = [
  createTask,
  listTasks,
  updateTask,
  completeTask,
  deleteTask,
  createEvent,
  listEvents,
  updateEvent,
  deleteEvent,
  findFreeSlots,
  whatNow,
  remember,
  recall,
  searchWeb,
  readUrl,
  logBook,
  listBooks,
  deleteBook,
  saveProject,
  listProjects,
  deleteProject,
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

/**
 * The schemas this deployment can honour.
 *
 * Filtered rather than fixed: a tool whose provider is not configured is not offered, so
 * the catalogue and the prompt's list of limits say the same thing. `getTool` still
 * resolves it by name —if a model asks for it anyway, the handler answers with the
 * configuration error instead of "that tool does not exist", which is the truth.
 */
export function toolSchemas(env: Env): ToolSchema[] {
  return TOOLS.filter((tool) => tool.available?.(env) ?? true).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
