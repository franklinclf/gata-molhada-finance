import { api } from './api.ts';
import type { CategoryRow } from './api.ts';
import { categoryOptions } from './category-options.ts';
import { useLoad } from './hooks.ts';
import { Select } from './Select.tsx';

/** Picks one of the categories, under their groups, with search and a way to create a new one. */
export function CategorySelect({ value, onChange, categories, ariaLabel = 'Categoria', placeholder = 'Escolher categoria', creatable = true, emptyLabel, class: className }: { value: string; onChange: (value: string) => void; categories?: readonly CategoryRow[]; ariaLabel?: string; placeholder?: string; creatable?: boolean; emptyLabel?: string; class?: string }) {
  const loaded = useLoad(() => (categories ? Promise.resolve(null) : api.categories()), [categories === undefined]);
  const items = categories ?? loaded.data?.items ?? [];
  const options = categoryOptions(items);
  // A value that is not in the list (a source's own label, say) still shows as it is.
  const withValue = value !== '' && !options.some((o) => o.value === value) ? [{ value, label: value, group: 'Atual' }, ...options] : options;
  return <Select class={className} value={value} onChange={onChange} options={withValue} placeholder={placeholder} ariaLabel={ariaLabel} creatable={creatable} searchable emptyLabel={emptyLabel} />;
}
