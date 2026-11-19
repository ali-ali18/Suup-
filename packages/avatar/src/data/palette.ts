// DATA MODULE (swappable): the colour palette.

export type AvatarColor = { id: string; name: string; value: string };

export const AVATAR_COLORS: readonly AvatarColor[] = [
  { id: "black", name: "Black", value: "#000000" },
  { id: "brown", name: "Brown", value: "#936439" },
  { id: "red", name: "Red", value: "#FF263C" },
  { id: "orange", name: "Orange", value: "#FF6700" },
  { id: "yellow", name: "Yellow", value: "#FF9800" },
  { id: "green", name: "Green", value: "#00C972" },
  { id: "cyan", name: "Cyan", value: "#00BCA6" },
  { id: "blue", name: "Blue", value: "#1084FE" },
  { id: "violet", name: "Violet", value: "#9159FE" },
  { id: "magenta", name: "Magenta", value: "#FF309B" },
  { id: "gray", name: "Gray", value: "#777777" },
];
