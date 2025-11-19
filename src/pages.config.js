import Create from './pages/Create';
import ShortTerm from './pages/ShortTerm';
import LongTerm from './pages/LongTerm';
import AISearch from './pages/AISearch';
import MemoryChat from './pages/MemoryChat';


export const PAGES = {
    "Create": Create,
    "ShortTerm": ShortTerm,
    "LongTerm": LongTerm,
    "AISearch": AISearch,
    "MemoryChat": MemoryChat,
}

export const pagesConfig = {
    mainPage: "Create",
    Pages: PAGES,
};