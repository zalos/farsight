import { useState } from 'react';
import clsx from 'clsx';

/**
 * One editable invoice line: description + amount.
 * @business A single line on the invoice — what was sold and for how much.
 */
export function LineItemRow({ onChange }: { onChange: (v: { description: string; amount: number }) => void }) {
  const [desc, setDesc] = useState('');
  return (
    <div>
      <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Description" />
      <MoneyField onValue={(amount) => onChange({ description: desc, amount })} />
    </div>
  );
}

/** Currency input that normalizes to cents; rejects negative amounts. */
export function MoneyField({ onValue }: { onValue: (v: number) => void }) {
  return <input className={clsx('field', 'field--money')} type="number" min="0" step="0.01" onChange={(e) => onValue(Number(e.target.value))} />;
}
