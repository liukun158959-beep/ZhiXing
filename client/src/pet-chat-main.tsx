import { createRoot } from 'react-dom/client';
import 'reend-components/styles.css';
import './client/index.css';
import './client/chat-prototype.css';
import { PetChat } from './client/pet-chat';

try { const dark=localStorage.getItem('tebb.theme') !== 'light';document.documentElement.classList.toggle('light',!dark);document.documentElement.classList.toggle('dark',dark); } catch { /* use default theme */ }
createRoot(document.getElementById('root')!).render(<PetChat />);

window.addEventListener('storage',e=>{if(e.key==='tebb.theme'){document.documentElement.classList.toggle('light',e.newValue==='light');document.documentElement.classList.toggle('dark',e.newValue!=='light');}});
