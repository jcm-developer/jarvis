import type { ToolSchema } from '../llm/provider';
import { findFreeSlots, whatNow } from './agenda';
import { createEvent, deleteEvent, listEvents, updateEvent } from './calendar';
import { recall, remember } from './memory';
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
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export function getTool(name: string): ToolDefinition | undefined {
  return BY_NAME.get(name);
}

export function toolSchemas(): ToolSchema[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}
