// Design-system demo page at #/design (QA). Registered by app.js through App.addPage; not shown in the side menu
// but reachable from the command palette. Shows tokens, components and states in the current theme and language.
import { field, chip, emptyState, errorState, skeleton, table, esc } from './html.js';

const SWATCHES = ['bg', 'surface', 'surface-2', 'ink', 'muted', 'line', 'accent', 'accent-fill', 'good', 'good-bg', 'warn', 'warn-bg', 'bad', 'bad-bg'];

export function registerDesignPage(App, { t }) {
  const L = {
    en: { colors: 'Color tokens', type: 'Type scale', buttons: 'Buttons', chips: 'Chips and notes', forms: 'Form controls and validation', tables: 'Table (sticky header, stacks on phones)',
      states: 'Empty, error and loading states', dialogs: 'Dialogs, toasts and palette', name: 'Name', nameErr: 'Name is required.', amount: 'Amount', amountHint: 'Digits are accepted in Arabic or Latin form.', kind: 'Type',
      confirm: 'Confirm dialog', prompt: 'Prompt dialog', modal: 'Custom modal', toastOk: 'Success toast', toastErr: 'Error toast', palette: 'Open command palette', date: 'Date', memo: 'Memo', balance: 'Balance',
      emptyT: 'No invoices yet', emptyX: 'Create your first invoice to see it here.', emptyA: 'Create invoice', errT: 'Could not load invoices', errX: 'The server did not answer. Nothing was changed.', retry: 'Try again',
      primary: 'Primary', secondary: 'Secondary', danger: 'Danger', ghost: 'Ghost', disabled: 'Disabled', small: 'Small', sample: 'The quick brown fox jumps over the lazy dog', ok: 'Looks good', warn: 'Needs attention', bad: 'Problem', info: 'Information',
      confirmQ: 'Delete this draft?', confirmM: 'This cannot be undone.', promptQ: 'Rename the draft', promptL: 'New name', modalT: 'Custom modal', modalB: 'Any HTML can go here. Tab stays inside, Escape closes, focus returns to the button.', close: 'Close', done: 'Done: ',
      cat: ['Sales', 'Purchases', 'Rent'] },
    ar: { colors: 'ألوان النظام', type: 'سلّم الخطوط', buttons: 'الأزرار', chips: 'الشارات والملاحظات', forms: 'عناصر النماذج والتحقق', tables: 'جدول (رأس ثابت ويتحول إلى بطاقات على الهاتف)',
      states: 'حالات: فارغ وخطأ وتحميل', dialogs: 'النوافذ والتنبيهات واللوحة', name: 'الاسم', nameErr: 'الاسم مطلوب.', amount: 'المبلغ', amountHint: 'تُقبل الأرقام العربية أو اللاتينية.', kind: 'النوع',
      confirm: 'نافذة تأكيد', prompt: 'نافذة إدخال', modal: 'نافذة مخصصة', toastOk: 'تنبيه نجاح', toastErr: 'تنبيه خطأ', palette: 'فتح لوحة الأوامر', date: 'التاريخ', memo: 'البيان', balance: 'الرصيد',
      emptyT: 'لا توجد فواتير بعد', emptyX: 'أنشئ أول فاتورة لتظهر هنا.', emptyA: 'إنشاء فاتورة', errT: 'تعذّر تحميل الفواتير', errX: 'لم يرد الخادم. لم يتغير شيء.', retry: 'حاول مرة أخرى',
      primary: 'أساسي', secondary: 'ثانوي', danger: 'خطر', ghost: 'شفاف', disabled: 'معطّل', small: 'صغير', sample: 'نص تجريبي لعرض شكل الخط في الواجهة العربية', ok: 'جيد', warn: 'يحتاج انتباهاً', bad: 'مشكلة', info: 'معلومة',
      confirmQ: 'حذف هذه المسودة؟', confirmM: 'لا يمكن التراجع عن هذا.', promptQ: 'إعادة تسمية المسودة', promptL: 'الاسم الجديد', modalT: 'نافذة مخصصة', modalB: 'يمكن وضع أي محتوى هنا. يبقى Tab داخل النافذة، ويغلقها Esc، ويعود التركيز إلى الزر.', close: 'إغلاق', done: 'تم: ',
      cat: ['المبيعات', 'المشتريات', 'الإيجار'] },
  };
  const l = () => L[App.state.lang];

  App.i18n.add('en', { 'sh.designTitle': 'Design system' });
  App.i18n.add('ar', { 'sh.designTitle': 'نظام التصميم' });

  const rows = Array.from({ length: 12 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, memo: `${l().cat[i % 3]} #${100 + i}`, amount: (i + 1) * 123456 }));

  App.addPage({
    id: 'design', titleKey: 'sh.designTitle', order: 990, nav: false,
    render() {
      const m = l();
      return `<div class="demo-stack">
      <section class="card"><h2>${esc(m.colors)}</h2><div class="swatches">${SWATCHES.map((n) => `<div class="swatch"><i class="sw-${n}"></i><span>--${n}</span></div>`).join('')}</div></section>
      <section class="card"><h2>${esc(m.type)}</h2><div class="type-scale"><p class="big">${esc(m.sample)}</p><p class="t-lg">${esc(m.sample)}</p><p class="t-md">${esc(m.sample)}</p><p>${esc(m.sample)}</p><p class="sub">${esc(m.sample)}</p></div></section>
      <section class="card"><h2>${esc(m.buttons)}</h2><div class="demo-row"><button class="primary">${esc(m.primary)}</button><button>${esc(m.secondary)}</button><button class="danger">${esc(m.danger)}</button><button class="ghost">${esc(m.ghost)}</button><button disabled>${esc(m.disabled)}</button><button class="small">${esc(m.small)}</button><a class="btn" href="#/">Link</a></div></section>
      <section class="card"><h2>${esc(m.chips)}</h2><div class="demo-row">${chip(m.info)}${chip(m.ok, 'good')}${chip(m.warn, 'warn')}${chip(m.bad, 'bad')}${chip('mute', 'mute')}</div>
        <div class="note">${esc(m.info)}</div><div class="note good">${esc(m.ok)}</div><div class="note warn">${esc(m.warn)}</div><div class="note bad">${esc(m.bad)}</div></section>
      <section class="card"><h2>${esc(m.forms)}</h2>
        ${field({ id: 'demo-name', label: m.name, required: true, error: m.nameErr })}
        ${field({ id: 'demo-amount', label: m.amount, type: 'text', value: '١٢٣٫٤٥', hint: m.amountHint })}
        ${field({ id: 'demo-kind', label: m.kind, type: 'select', options: m.cat, value: m.cat[1] })}
        ${field({ id: 'demo-memo', label: m.memo, type: 'textarea' })}</section>
      <section class="card"><h2>${esc(m.tables)}</h2>${table({ columns: [{ key: 'date', label: m.date }, { key: 'memo', label: m.memo }, { key: 'amount', label: m.balance, num: true }], rows: rows.map((r) => ({ ...r, amount: App.money(r.amount) })) })}</section>
      <section class="card"><h2>${esc(m.states)}</h2><div class="demo-stack">${emptyState({ title: m.emptyT, text: m.emptyX, action: { href: '#/', label: m.emptyA } })}${errorState({ title: m.errT, text: m.errX, retryLabel: m.retry, retryAct: 'demo-retry' })}${skeleton({ cards: 2, lines: 2 })}</div></section>
      <section class="card"><h2>${esc(m.dialogs)}</h2><div class="demo-row">
        <button data-sh="demo-confirm">${esc(m.confirm)}</button><button data-sh="demo-prompt">${esc(m.prompt)}</button><button data-sh="demo-modal">${esc(m.modal)}</button>
        <button data-sh="demo-toast-ok">${esc(m.toastOk)}</button><button data-sh="demo-toast-err">${esc(m.toastErr)}</button><button data-sh="palette">${esc(m.palette)}</button></div></section></div>`;
    },
  });

  const a = App.shellActions;
  a['demo-confirm'] = async () => { const ok = await App.confirm({ title: l().confirmQ, message: l().confirmM, danger: true }); App.toast(l().done + ok, ok); };
  a['demo-prompt'] = async () => { const v = await App.prompt({ title: l().promptQ, label: l().promptL, value: 'Draft 1' }); App.toast(l().done + (v ?? 'null'), v != null); };
  a['demo-modal'] = () => App.modal({ title: l().modalT, bodyHtml: `<p>${esc(l().modalB)}</p>`, actions: [{ label: l().close, value: true, primary: true }] });
  a['demo-toast-ok'] = () => App.toast(l().ok, true);
  a['demo-toast-err'] = () => App.toast(l().bad, false);
  a['demo-retry'] = () => App.toast(l().retry, true);
}
