import {
  createElement, ArrowDownToLine, ArrowUp, ArrowUpRight, Blocks, Box, Brain,
  ChevronDown, ChevronRight, Download, Eye, EyeOff, FilePlus2, FolderOpen,
  GitBranch, HardDrive, History, Image, Keyboard, ListEnd, LogIn, Minus,
  Palette, PanelLeft, Pencil, Plus, RefreshCw, RotateCcw, Search, Settings2,
  ShieldCheck, SlidersHorizontal, SquarePen, SquareTerminal, Trash2, Unplug,
  Upload, X, Minimize2, Maximize, Minimize, PanelTopClose, PanelTopOpen, Type, Sun, Moon, type IconNode,
  Paperclip, Slash, Square, TextCursorInput, Files, File, Folder, AtSign, Save, Pin, Archive,
  Check, CircleAlert, GitPullRequest, Command, Bot, Wrench, NotebookPen,
} from "lucide";

const icons: Record<string, IconNode> = {
  "arrow-down-to-line": ArrowDownToLine, "arrow-up": ArrowUp,
  "arrow-up-right": ArrowUpRight, blocks: Blocks, box: Box, brain: Brain,
  "chevron-down": ChevronDown, "chevron-right": ChevronRight, download: Download,
  eye: Eye, "eye-off": EyeOff, "file-plus-2": FilePlus2, "folder-open": FolderOpen,
  "git-branch": GitBranch, "hard-drive": HardDrive, history: History, image: Image,
  keyboard: Keyboard, "list-end": ListEnd, "log-in": LogIn, minus: Minus,
  palette: Palette, "panel-left": PanelLeft, pencil: Pencil, plus: Plus,
  "refresh-cw": RefreshCw, "rotate-ccw": RotateCcw, search: Search,
  "settings-2": Settings2, "shield-check": ShieldCheck,
  "sliders-horizontal": SlidersHorizontal, "square-pen": SquarePen,
  "terminal-square": SquareTerminal, "trash-2": Trash2, unplug: Unplug,
  upload: Upload, x: X, "minimize-2": Minimize2, maximize: Maximize, minimize: Minimize,
  "panel-top-close": PanelTopClose, "panel-top-open": PanelTopOpen,
  type: Type, sun: Sun, moon: Moon,
  paperclip: Paperclip, slash: Slash, square: Square, "text-cursor-input": TextCursorInput,
  files: Files, file: File, folder: Folder, "at-sign": AtSign, save: Save, pin: Pin, archive: Archive,
  check: Check, "circle-alert": CircleAlert, "git-pull-request": GitPullRequest, command: Command,
  bot: Bot, wrench: Wrench, "notebook-pen": NotebookPen,
};

export function icon(name: string): SVGElement {
  return createElement(icons[name] || SquareTerminal, {
    class: "lucide", "aria-hidden": "true", width: "16", height: "16",
  });
}

export function renderIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>("[data-icon]").forEach((element) => {
    const image = icon(element.dataset.icon!);
    if (element.tagName === "BUTTON") element.replaceChildren(image);
    else element.replaceWith(image);
  });
}
