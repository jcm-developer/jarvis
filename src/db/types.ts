export interface UserRow {
  id: string;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  timezone: string;
}

export interface ConversationRow {
  id: string;
  user_id: string;
  telegram_chat_id: number;
}

export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  priority: number;
  status: 'pending' | 'done' | 'cancelled';
  completed_at: string | null;
  created_at: string;
}

export interface MemoryRow {
  id: string;
  user_id: string;
  key: string;
  value: string;
  updated_at: string;
}
