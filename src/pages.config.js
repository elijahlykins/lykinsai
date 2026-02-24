import MemoryChat from './pages/MemoryChat';
import TagManagement from './pages/TagManagement';
import Reminders from './pages/Reminders';
import Trash from './pages/Trash';
import Billing from './pages/Billing';
import Memory from './pages/Memory';
import OmniaCanvas from "./pages/OmniaCanvas";


export const PAGES = {
    "OmniaCanvas": OmniaCanvas,
    "MemoryChat": MemoryChat,
    "TagManagement": TagManagement,
    "Reminders": Reminders,
    "Trash": Trash,
    "Billing": Billing,
    "Memory": Memory,
}

export const pagesConfig = {
    mainPage: "OmniaCanvas",
    Pages: PAGES,
};