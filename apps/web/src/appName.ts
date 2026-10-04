/** 首页顶栏默认名；没改过名字时，标签页仍用下面的产品名。 */
export const DEFAULT_HOME_TITLE = "Agents";
export const DEFAULT_TAB_TITLE = "CMUX Agent Remote";
export const APP_NAME_KEY = "car.app-name.v1";
export const APP_NAME_MAX_LENGTH = 40;

export function loadStoredAppName(): string {
  try {
    const value = window.localStorage.getItem(APP_NAME_KEY);
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export function persistAppName(name: string): string {
  const trimmed = name.trim().slice(0, APP_NAME_MAX_LENGTH);
  try {
    if (trimmed.length === 0) window.localStorage.removeItem(APP_NAME_KEY);
    else window.localStorage.setItem(APP_NAME_KEY, trimmed);
  } catch {
    // 隐私模式写不了就只活在内存里
  }
  return trimmed;
}

export function homeTitleOf(stored: string): string {
  return stored.length > 0 ? stored : DEFAULT_HOME_TITLE;
}

export function tabTitleOf(stored: string): string {
  return stored.length > 0 ? stored : DEFAULT_TAB_TITLE;
}
