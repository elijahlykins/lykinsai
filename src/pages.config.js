import Create from './pages/Create';
import MemoryChat from './pages/MemoryChat';
import Notes from './pages/Notes';
import TagManagement from './pages/TagManagement';
import Reminders from './pages/Reminders';
import Trash from './pages/Trash';
import Billing from './pages/Billing';
import Memory from './pages/Memory';


export const PAGES = {
    "Create": Create,
    "MemoryChat": MemoryChat,
    "Notes": Notes,
    "TagManagement": TagManagement,
    "Reminders": Reminders,
    "Trash": Trash,
    "Billing": Billing,
    "Memory": Memory,
}

export const pagesConfig = {
    mainPage: "Create",
    Pages: PAGES,
};