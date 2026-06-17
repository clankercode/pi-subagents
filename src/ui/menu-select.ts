/**
 * menu-select.ts — Custom select dialog with left/right arrow navigation.
 *
 * Mirrors `ctx.ui.select()` but adds horizontal arrow semantics for nested
 * menus: left arrow goes back (like Esc), right arrow selects (like Enter).
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

export interface MenuSelectOptions {
  title: string;
  options: string[];
  /** Optional descriptions keyed by option string. */
  descriptions?: Record<string, string>;
  /** Maximum number of items visible at once. Defaults to all items. */
  maxVisible?: number;
}

/**
 * Show a selectable menu and return the chosen option, or `undefined` if the
 * user backed out with Esc or the left arrow.
 */
export async function menuSelect(
  ctx: ExtensionCommandContext,
  opts: MenuSelectOptions,
): Promise<string | undefined> {
  const items = opts.options.map((value) => ({
    value,
    label: value,
    description: opts.descriptions?.[value],
  }));

  return ctx.ui.custom<string | undefined>((_tui, theme, _kb, done) => {
    const list = new SelectList(
      items,
      opts.maxVisible ?? Math.max(5, items.length + 2),
      getSelectListTheme(),
    );
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);

    const container = new Container();
    container.addChild(new Text(theme.bold(opts.title), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "left") || matchesKey(data, "escape")) {
          done(undefined);
          return;
        }
        if (matchesKey(data, "right") || matchesKey(data, "enter")) {
          const selected = list.getSelectedItem();
          if (selected) {
            done(selected.value);
          }
          return;
        }
        list.handleInput(data);
      },
    };
  });
}
