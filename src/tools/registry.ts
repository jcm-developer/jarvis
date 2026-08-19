import type { ToolSchema } from '../llm/provider';
import { createEvent, deleteEvent, listEvents, updateEvent } from './calendar';
import { recall, remember } from './memory';
import { completeTask, createTask, deleteTask, listTasks, updateTask } from './tasks';
import type { ToolDefinition } from './types';

/**
 * Catálogo de herramientas.
 *
 * Esto es el "manual de instrucciones" del agente, pero en forma de JSON Schema
 * en el campo `tools` de la petición, no en prosa dentro del prompt. El modelo
 * recibe firmas tipadas en vez de una descripción que tenga que interpretar.
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
