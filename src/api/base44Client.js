// src/api/base44Client.js
console.warn('⚠️ base44 is deprecated! This is a stub for compatibility.');

// Mock entities.Note
const Note = {
  list: async () => {
    console.warn('base44 Note.list() called — should use Supabase instead');
    return [];
  },
  create: async (data) => {
    console.warn('base44 Note.create() called — should use Supabase instead');
    return { id: 'mock-id', ...data };
  },
  update: async (id, data) => {
    console.warn('base44 Note.update() called — should use Supabase instead');
    return { id, ...data };
  },
  delete: async (id) => {
    console.warn('base44 Note.delete() called — should use Supabase instead');
    return {};
  }
};

// Mock entities.Folder
const Folder = {
  list: async () => {
    console.warn('base44 Folder.list() called — should use Supabase instead');
    return [];
  },
  create: async (data) => {
    console.warn('base44 Folder.create() called — should use Supabase instead');
    return { id: 'mock-id', ...data };
  }
};

// Mock integrations.Core.InvokeLLM
const InvokeLLM = async (options) => {
  console.error('🔥 base44 InvokeLLM called! This should be replaced with your AI proxy.');
  console.error('Prompt:', options.prompt);
  // Return mock response so UI doesn’t crash
  return 'This is a mock AI response. Please update this component to use your AI proxy.';
};

const UploadFile = async (options) => {
  console.warn('base44 UploadFile called — not implemented in new system yet');
  return { file_url: '' };
};

// Mock auth
const auth = {
  me: async () => {
    console.warn('base44 auth.me() called — no auth system active');
    return { email: 'anonymous@example.com', plan: 'free' };
  },
  logout: () => {
    console.warn('base44 auth.logout() called');
  },
  redirectToLogin: () => {
    console.warn('base44 auth.redirectToLogin() called');
  }
};

export const base44 = {
  entities: { Note, Folder },
  integrations: { Core: { InvokeLLM, UploadFile } },
  auth
};