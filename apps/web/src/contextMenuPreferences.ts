let hideUnavailableContextMenuItems = false;

export function setHideUnavailableContextMenuItems(value: boolean): void {
  hideUnavailableContextMenuItems = value;
}

export function shouldHideUnavailableContextMenuItems(): boolean {
  return hideUnavailableContextMenuItems;
}
