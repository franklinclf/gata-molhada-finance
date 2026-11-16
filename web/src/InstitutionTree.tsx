import { useEffect, useRef, useState } from 'preact/hooks';
import { accountOn, buildTree, nodeState, startsOpen, toggleAccount, toggleInstitution, type CheckState, type TreeNode } from './inst-tree.ts';
import { accountName } from './names.ts';

interface AccountFacet {
  id: string;
  institution: string;
  name: string;
  kind: string;
  last4: string | null;
  count: number;
}

/** A checkbox that can show the "some" state, which only a property (not an attribute) can set. */
function TriBox({ state, label, onChange }: { state: CheckState; label: string; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);
  return <input ref={ref} type="checkbox" aria-label={label} checked={state === 'on'} onChange={onChange} />;
}

/** Institutions with their accounts and cards underneath. Ticking an institution sets `institution`, ticking an account sets `accountId`. */
export function InstitutionTree({ institutions, accounts, selectedInstitutions, selectedAccounts, onChange }: { institutions: Array<{ name: string; count: number }>; accounts: AccountFacet[]; selectedInstitutions: string[]; selectedAccounts: string[]; onChange: (next: { institution: string[]; accountId: string[] }) => void }) {
  const tree: TreeNode[] = buildTree(institutions, accounts);
  const byId = new Map(accounts.map((a) => [a.id, a]));
  // Only what the person opened or closed is remembered; the rest follows the default (few accounts: open).
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  if (tree.length === 0) return <div class="muted">Nada encontrado</div>;
  return (
    <ul class="tree">
      {tree.map((node) => {
        const state = nodeState(node, selectedInstitutions, selectedAccounts);
        const open = folded[node.institution] ?? startsOpen(node, state);
        return (
          <li key={node.institution}>
            <div class="tree-row">
              <button type="button" class="tree-toggle" aria-expanded={open} aria-label={`${open ? 'Recolher' : 'Expandir'} ${node.institution || 'Sem instituição'}`} onClick={() => setFolded({ ...folded, [node.institution]: !open })}>
                {open ? '▾' : '▸'}
              </button>
              <label class="option grow">
                <TriBox state={state} label={node.institution || 'Sem instituição'} onChange={() => onChange(toggleInstitution(node, selectedInstitutions, selectedAccounts))} />
                <span class="grow clip">{node.institution || 'Sem instituição'}</span>
                <span class="muted">{node.count}</span>
              </label>
            </div>
            {open && (
              <ul class="tree-children">
                {node.accounts.map((a) => {
                  const full = byId.get(a.id);
                  const label = full ? `${accountName(full.institution, full.name, full.kind)}${full.last4 ? ` •••• ${full.last4}` : ''}` : a.id;
                  return (
                    <li key={a.id}>
                      <label class="option">
                        <input type="checkbox" checked={accountOn(node, a.id, selectedInstitutions, selectedAccounts)} onChange={() => onChange(toggleAccount(node, a.id, selectedInstitutions, selectedAccounts))} />
                        <span class="grow clip">{label}</span>
                        <span class="muted">{a.count}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}
