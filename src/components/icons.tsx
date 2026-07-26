/**
 * App icons — Tabler Icons only (same approach as grok-app).
 * Stable `Icon*` names for call sites.
 * @see https://tabler.io/icons
 */

import type { ComponentType } from "react";
import {
  IconCheck as TbCheck,
  IconChevronDown as TbChevronDown,
  IconChevronRight as TbChevronRight,
  IconDots as TbDots,
  IconEdit as TbEdit,
  IconCopy as TbCopy,
  IconFirstAidKit as TbFirstAidKit,
  IconFolder as TbFolder,
  IconLayoutSidebar as TbLayoutSidebar,
  IconLayoutSidebarRight as TbLayoutSidebarRight,
  IconMessage as TbMessage,
  IconMinus as TbMinus,
  IconMoon as TbMoon,
  IconPlayerStop as TbPlayerStop,
  IconPlug as TbPlug,
  IconPlus as TbPlus,
  IconRefresh as TbRefresh,
  IconRobot as TbRobot,
  IconSearch as TbSearch,
  IconSend as TbSend,
  IconSettings as TbSettings,
  IconQuote as TbQuote,
  IconSquare as TbSquare,
  IconSun as TbSun,
  IconX as TbX,
} from "@tabler/icons-react";

export type IconProps = {
  size?: number;
  title?: string;
  className?: string;
  stroke?: number;
};

type TbIcon = ComponentType<{
  size?: number | string;
  stroke?: number;
  color?: string;
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

function wrap(Tb: TbIcon, defaults?: { stroke?: number; className?: string }) {
  function TablerAppIcon({
    size = 18,
    title,
    stroke = defaults?.stroke ?? 1.75,
    className = "",
  }: IconProps) {
    const classes = ["g-icon", defaults?.className, className]
      .filter(Boolean)
      .join(" ");
    return (
      <span
        className={classes}
        style={{
          display: "inline-flex",
          width: size,
          height: size,
          lineHeight: 0,
          color: "currentColor",
          flexShrink: 0,
          alignItems: "center",
          justifyContent: "center",
        }}
        role={title ? "img" : undefined}
        aria-hidden={title ? undefined : true}
        aria-label={title}
        title={title}
      >
        <Tb size={size} stroke={stroke} color="currentColor" aria-hidden />
      </span>
    );
  }
  return TablerAppIcon;
}

/** Workbench brand mark — geometric W monogram (currentColor, theme-aware). */
export function IconWorkbenchMark({
  size = 20,
  title = "Workbench",
  className = "",
}: IconProps) {
  const classes = ["g-icon", "g-icon--wb-mark", className].filter(Boolean).join(" ");
  return (
    <span
      className={classes}
      style={{
        display: "inline-flex",
        width: size,
        height: size,
        lineHeight: 0,
        color: "currentColor",
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      title={title}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <path
          d="M4 5.5h2.6l2.1 9.2L12 7.2l3.3 7.5 2.1-9.2H20v13h-2.2V11.4L15.2 19h-2.3L12 14.6 11.1 19H8.8L6.2 11.4V18.5H4v-13z"
          fill="currentColor"
        />
      </svg>
    </span>
  );
}

export const IconSearch = wrap(TbSearch);
export const IconNewChat = wrap(TbEdit);
export const IconCopy = wrap(TbCopy);
export const IconCheck = wrap(TbCheck, { stroke: 2 });
export const IconChevronDown = wrap(TbChevronDown);
export const IconChevronRight = wrap(TbChevronRight);
export const IconPlus = wrap(TbPlus);
export const IconMore = wrap(TbDots);
export const IconFolder = wrap(TbFolder);
export const IconClose = wrap(TbX);
export const IconSend = wrap(TbSend);
export const IconPanel = wrap(TbLayoutSidebar);
export const IconPanelRight = wrap(TbLayoutSidebarRight);
export const IconSettings = wrap(TbSettings);
export const IconDoctor = wrap(TbFirstAidKit);
export const IconStop = wrap(TbPlayerStop);
export const IconRefresh = wrap(TbRefresh);
export const IconQuote = wrap(TbQuote);
export const IconMinimize = wrap(TbMinus);
export const IconMaximize = wrap(TbSquare);
export const IconChat = wrap(TbMessage);
export const IconRobot = wrap(TbRobot);
export const IconPlug = wrap(TbPlug);
export const IconThemeSun = wrap(TbSun);
export const IconThemeMoon = wrap(TbMoon);
