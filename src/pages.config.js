import Notes from './pages/Notes';
import Create from './pages/Create';
import ShortTerm from './pages/ShortTerm';
import LongTerm from './pages/LongTerm';
import AISearch from './pages/AISearch';
import MemoryChat from './pages/MemoryChat';


export const PAGES = {
    "Notes": Notes,
    "Create": Create,
    "ShortTerm": ShortTerm,
    "LongTerm": LongTerm,
    "AISearch": AISearch,
    "MemoryChat": MemoryChat,
}

export const pagesConfig = {
    mainPage: "Notes",
    Pages: PAGES,
};