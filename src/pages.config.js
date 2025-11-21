import Create from './pages/Create';
import ShortTerm from './pages/ShortTerm';
import LongTerm from './pages/LongTerm';
import AISearch from './pages/AISearch';
import MemoryChat from './pages/MemoryChat';
import Notes from './pages/Notes';
import TagManagement from './pages/TagManagement';
import Reminders from './pages/Reminders';
import Trash from './pages/Trash';


export const PAGES = {
    "Create": Create,
    "ShortTerm": ShortTerm,
    "LongTerm": LongTerm,
    "AISearch": AISearch,
    "MemoryChat": MemoryChat,
    "Notes": Notes,
    "TagManagement": TagManagement,
    "Reminders": Reminders,
    "Trash": Trash,
}

export const pagesConfig = {
    mainPage: "Create",
    Pages: PAGES,
};