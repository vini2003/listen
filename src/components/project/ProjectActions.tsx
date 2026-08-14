import { Check, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useState } from "react";
import type { Project } from "../../domain/models";
import { useDismissableLayer } from "../../hooks/useDismissableLayer";
import { useWorkspace } from "../../store/workspace";
import { Modal } from "../ui/Modal";

interface ProjectActionsProps {
  project: Project;
  placement?: "sidebar" | "page";
}

export function ProjectActions({ project, placement = "page" }: ProjectActionsProps) {
  const { renameProject, deleteProject, busy } = useWorkspace();
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [name, setName] = useState(project.name);
  const menuRef = useDismissableLayer<HTMLDivElement>(menuOpen, () => setMenuOpen(false));

  useEffect(() => setName(project.name), [project.name]);

  async function saveRename(): Promise<void> {
    const nextName = name.trim();
    if (!nextName || nextName === project.name) { setRenameOpen(false); return; }
    if (await renameProject(project.id, nextName)) setRenameOpen(false);
  }

  return (
    <>
      <div className={`project-actions project-actions-${placement}`} ref={menuRef} onPointerDown={(event) => event.stopPropagation()}>
        <button
          className={placement === "sidebar" ? "row-action" : "icon-button"}
          aria-label={`Project options for ${project.name}`}
          onClick={(event) => { event.stopPropagation(); setMenuOpen((current) => !current); }}
        >
          <MoreHorizontal size={placement === "sidebar" ? 15 : 18} />
        </button>
        <AnimatePresence>
          {menuOpen ? (
            <motion.div className="project-menu" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}>
              <button onClick={() => { setMenuOpen(false); setName(project.name); setRenameOpen(true); }}><Pencil size={15} /> Rename</button>
              <div className="menu-divider" />
              <button className="danger-menu-item" onClick={() => { setMenuOpen(false); setDeleteOpen(true); }}><Trash2 size={15} /> Delete</button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <Modal open={renameOpen} title="Rename project" onClose={() => setRenameOpen(false)} size="small">
        <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); void saveRename(); }}>
          <label><span>Project name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          <div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => setRenameOpen(false)}>Cancel</button><button className="primary-button" disabled={!name.trim() || busy}><Check size={15} /> Save</button></div>
        </form>
      </Modal>

      <Modal open={deleteOpen} title="Delete project?" description="The recordings will move to Unsorted. Their audio and transcripts will remain available." onClose={() => setDeleteOpen(false)} size="small">
        <div className="confirmation-content">
          <p><strong>{project.name}</strong> will be removed from the sidebar.</p>
          <div className="dialog-actions"><button className="secondary-button" onClick={() => setDeleteOpen(false)}>Cancel</button><button className="danger-button" disabled={busy} onClick={() => { void deleteProject(project.id).then((deleted) => { if (deleted) setDeleteOpen(false); }); }}>Delete project</button></div>
        </div>
      </Modal>
    </>
  );
}
