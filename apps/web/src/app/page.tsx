import { redirect } from "next/navigation";
import { Paths } from "@/constants/paths";

export default function Home() {
  redirect(Paths.CANDIDATES);
}
