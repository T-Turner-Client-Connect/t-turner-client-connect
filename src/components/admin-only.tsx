import { Notice } from "@/components/ui";

export function AdminOnly() {
  return <Notice tone="warn" title="Admins only">Ask an Admin if you need access to this page.</Notice>;
}
