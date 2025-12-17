import './App.css';
import { Toaster } from "@/components/ui/toaster";
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClientInstance } from '@/lib/query-client';
import VisualEditAgent from '@/lib/VisualEditAgent';
import NavigationTracker from '@/lib/NavigationTracker';
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { SupabaseAuthProvider } from '@/lib/SupabaseAuth';

// ✅ CORRECT IMPORTS (no spaces, match your filenames)
import Create from "./pages/Create";
import Memory from "./pages/Memory";
import TagManagement from "./pages/TagManagement";
import Trash from "./pages/Trash";
import MemoryChat from "./pages/MemoryChat";
import Reminders from "./pages/Reminders";
import Billing from "./pages/Billing"; // ← FIXED: removed space after "./"

function App() {
  return (
    <QueryClientProvider client={queryClientInstance}>
      <SupabaseAuthProvider>
        <Router>
          <NavigationTracker />
          <Routes>
            <Route path="/" element={<Create />} />
            <Route path="/create" element={<Create />} />
            <Route path="/memory" element={<Memory />} />
            <Route path="/tag-management" element={<TagManagement />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/memorychat" element={<MemoryChat />} />
            <Route path="/memory-chat" element={<MemoryChat />} />
            <Route path="/reminders" element={<Reminders />} />
            <Route path="/billing" element={<Billing />} />
            <Route path="*" element={<PageNotFound />} />
          </Routes>
        </Router>
        <Toaster />
        <VisualEditAgent />
      </SupabaseAuthProvider>
    </QueryClientProvider>
  );
}

export default App;