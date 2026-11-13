// Strings (English, Arabic) and the translate function. Modules add their own through App.i18n.add.
import { state } from '/core/state.js';

export const T = {
  en: {
    title: 'Accounting PoC', user: 'Signed in as', role: 'Role', perms: 'permissions', nothing: 'Nothing here.',
    create: 'Create', amount: 'Amount (EGP)', date: 'Date', reason: 'Reason', saved: 'Done.', lang: 'العربية', ok: 'OK',
    noteBox: 'Proof of concept: demo identity switcher, mock ETA, in-memory data. Not for real accounting.',
    'sh.home': 'Home', 'sh.skip': 'Skip to content', 'sh.menu': 'Menu', 'sh.nav': 'Main navigation', 'sh.quickNav': 'Quick navigation',
    'sh.searchBtn': 'Search…', 'sh.searchLabel': 'Search pages, actions and cards', 'sh.searchHint': 'Type to search', 'sh.noResults': 'No results',
    'sh.themeToDark': 'Switch to dark theme', 'sh.themeToLight': 'Switch to light theme', 'sh.language': 'Language',
    'sh.account': 'Account menu', 'sh.signOut': 'Sign out', 'sh.digits': 'Digits', 'sh.digitsAuto': 'Automatic', 'sh.digitsLatn': 'Western (0123)', 'sh.digitsArab': 'Arabic-Indic (٠١٢٣)',
    'sh.close': 'Close', 'sh.dismiss': 'Dismiss', 'sh.cancel': 'Cancel', 'sh.confirm': 'Please confirm', 'sh.required': 'This field is required.',
    'sh.loadFailed': 'Could not load the data', 'sh.retry': 'Try again', 'sh.offline': 'You are offline. New quick sales, invoices, bills and customers are saved on this device and sent when you reconnect; everything else needs a connection. Figures shown may be out of date.',
    'sh.offlineShort': 'No connection. Nothing was saved.', 'sh.online': 'Back online.',
    'sh.notFound': 'Page not found', 'sh.notFoundText': 'This address does not match any page.', 'sh.noAccess': 'This page is not available for your role.',
    'sh.goHome': 'Go to Home', 'sh.homeEmpty': 'Nothing to show yet', 'sh.homeEmptyText': 'No cards are available for your role. Ask an administrator to review your permissions.',
    'sh.pageEmpty': 'This page has no content for your role.',
    'sh.authTitle': 'Sign-in required', 'sh.authNone': 'Your session needs a sign-in, but this build has no sign-in screen installed yet. Pick a demo user from the switcher or ask the administrator.',
    'sh.workspaces': 'Your workspaces',
    'sh.gPages': 'Pages', 'sh.gActions': 'Actions', 'sh.gCards': 'Cards', 'sh.go': 'Go to', 'sh.navigate': 'navigate', 'sh.select': 'select', 'sh.toClose': 'close',
    'sh.cmdTheme': 'Toggle light / dark theme', 'sh.cmdThemeSystem': 'Use the system theme', 'sh.cmdLang': 'Switch language (English / العربية)', 'sh.cmdNav': 'Collapse or expand the side menu',
    'sh.cmdHelp': 'Show keyboard shortcuts', 'sh.cmdReload': 'Reload data', 'sh.cmdInstall': 'Install the app', 'sh.cmdSignOut': 'Sign out',
    'sh.helpTitle': 'Keyboard shortcuts', 'sh.kPalette': 'Open the command palette', 'sh.kSearch': 'Search (same palette)', 'sh.kGo': 'Go to the Nth menu item (g then 1-9, g then h for Home)',
    'sh.kNav': 'Collapse or expand the side menu', 'sh.kHelp': 'Show this help', 'sh.kEsc': 'Close dialogs and menus',
    'sh.onTitle': 'Welcome, here is a quick start', 'sh.onHide': 'Hide this guide',
    'sh.on1': 'Use the menu to move between areas. Press Ctrl+K (or Cmd+K) to search pages, actions and cards.',
    'sh.onSales': 'Record your first sale or invoice in the Sales area.', 'sh.onTeam': 'Add your team and give each person only the access they need.',
    'sh.onInstall': 'Install this app on your phone or desktop for faster access.', 'sh.onInstallBtn': 'Install',
    'sh.onPhone': 'It works on phones: use the menu button at the top or the bar at the bottom.',
    'sh.onExport': 'Your data is yours: a full export is always available.',
    'sh.designTitle': 'Design system', 'sh.install': 'Install',
  },
  ar: {
    title: 'نموذج أولي للمحاسبة', user: 'تسجيل الدخول باسم', role: 'الدور', perms: 'صلاحية', nothing: 'لا يوجد شيء.',
    create: 'إنشاء', amount: 'المبلغ (ج.م)', date: 'التاريخ', reason: 'السبب', saved: 'تم.', lang: 'English', ok: 'حسناً',
    noteBox: 'نموذج أولي: تبديل مستخدم تجريبي، ETA تجريبي، بيانات في الذاكرة. غير مخصص للمحاسبة الفعلية.',
    'sh.home': 'الرئيسية', 'sh.skip': 'تخطَّ إلى المحتوى', 'sh.menu': 'القائمة', 'sh.nav': 'التنقل الرئيسي', 'sh.quickNav': 'تنقل سريع',
    'sh.searchBtn': 'بحث…', 'sh.searchLabel': 'ابحث في الصفحات والإجراءات والبطاقات', 'sh.searchHint': 'اكتب للبحث', 'sh.noResults': 'لا توجد نتائج',
    'sh.themeToDark': 'التبديل إلى المظهر الداكن', 'sh.themeToLight': 'التبديل إلى المظهر الفاتح', 'sh.language': 'اللغة',
    'sh.account': 'قائمة الحساب', 'sh.signOut': 'تسجيل الخروج', 'sh.digits': 'الأرقام', 'sh.digitsAuto': 'تلقائي', 'sh.digitsLatn': 'غربية (0123)', 'sh.digitsArab': 'عربية هندية (٠١٢٣)',
    'sh.close': 'إغلاق', 'sh.dismiss': 'إخفاء', 'sh.cancel': 'إلغاء', 'sh.confirm': 'يرجى التأكيد', 'sh.required': 'هذا الحقل مطلوب.',
    'sh.loadFailed': 'تعذّر تحميل البيانات', 'sh.retry': 'حاول مرة أخرى', 'sh.offline': 'أنت غير متصل. تُحفظ على هذا الجهاز عمليات البيع السريع والفواتير وفواتير الموردين والعملاء الجدد وتُرسل عند عودة الاتصال؛ أما بقية العمليات فتحتاج إلى اتصال. قد تكون الأرقام المعروضة قديمة.',
    'sh.offlineShort': 'لا يوجد اتصال. لم يتم حفظ شيء.', 'sh.online': 'عاد الاتصال.',
    'sh.notFound': 'الصفحة غير موجودة', 'sh.notFoundText': 'هذا العنوان لا يطابق أي صفحة.', 'sh.noAccess': 'هذه الصفحة غير متاحة لدورك.',
    'sh.goHome': 'الذهاب إلى الرئيسية', 'sh.homeEmpty': 'لا شيء لعرضه بعد', 'sh.homeEmptyText': 'لا توجد بطاقات متاحة لدورك. اطلب من المسؤول مراجعة صلاحياتك.',
    'sh.pageEmpty': 'لا يوجد محتوى لهذه الصفحة لدورك.',
    'sh.authTitle': 'تسجيل الدخول مطلوب', 'sh.authNone': 'جلستك تحتاج إلى تسجيل الدخول، لكن لا توجد شاشة دخول في هذا الإصدار بعد. اختر مستخدماً تجريبياً أو اطلب من المسؤول.',
    'sh.workspaces': 'مساحات عملك',
    'sh.gPages': 'الصفحات', 'sh.gActions': 'الإجراءات', 'sh.gCards': 'البطاقات', 'sh.go': 'الانتقال إلى', 'sh.navigate': 'تنقل', 'sh.select': 'اختيار', 'sh.toClose': 'إغلاق',
    'sh.cmdTheme': 'تبديل المظهر الفاتح / الداكن', 'sh.cmdThemeSystem': 'استخدام مظهر النظام', 'sh.cmdLang': 'تبديل اللغة (English / العربية)', 'sh.cmdNav': 'طيّ القائمة الجانبية أو توسيعها',
    'sh.cmdHelp': 'عرض اختصارات لوحة المفاتيح', 'sh.cmdReload': 'إعادة تحميل البيانات', 'sh.cmdInstall': 'تثبيت التطبيق', 'sh.cmdSignOut': 'تسجيل الخروج',
    'sh.helpTitle': 'اختصارات لوحة المفاتيح', 'sh.kPalette': 'فتح لوحة الأوامر', 'sh.kSearch': 'بحث (اللوحة نفسها)', 'sh.kGo': 'الانتقال إلى العنصر رقم N في القائمة (g ثم 1-9، وg ثم h للرئيسية)',
    'sh.kNav': 'طيّ القائمة الجانبية أو توسيعها', 'sh.kHelp': 'عرض هذه المساعدة', 'sh.kEsc': 'إغلاق النوافذ والقوائم',
    'sh.onTitle': 'مرحباً، إليك بداية سريعة', 'sh.onHide': 'إخفاء هذا الدليل',
    'sh.on1': 'استخدم القائمة للتنقل بين الأقسام. اضغط Ctrl+K (أو Cmd+K) للبحث في الصفحات والإجراءات والبطاقات.',
    'sh.onSales': 'سجّل أول عملية بيع أو فاتورة من قسم المبيعات.', 'sh.onTeam': 'أضف فريقك وامنح كل شخص الصلاحيات التي يحتاجها فقط.',
    'sh.onInstall': 'ثبّت التطبيق على هاتفك أو حاسوبك للوصول الأسرع.', 'sh.onInstallBtn': 'تثبيت',
    'sh.onPhone': 'يعمل على الهاتف: استخدم زر القائمة في الأعلى أو الشريط في الأسفل.',
    'sh.onExport': 'بياناتك ملكك: التصدير الكامل متاح دائماً.',
    'sh.designTitle': 'نظام التصميم', 'sh.install': 'تثبيت',
  },
};

export const t = (k) => T[state.lang][k] ?? T.en[k] ?? k;

/** Add strings for 'en' or 'ar'. Re-adding a key with different text is an error; identical text is fine. */
export function addStrings(lang, dict) {
  if (!T[lang]) throw new Error(`Unknown language "${lang}" (use 'en' or 'ar')`);
  for (const [k, v] of Object.entries(dict)) {
    if (k in T[lang] && T[lang][k] !== v) throw new Error(`i18n key "${k}" (${lang}) is already defined with different text`);
    T[lang][k] = v;
  }
}
