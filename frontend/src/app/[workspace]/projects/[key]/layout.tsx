import { ProjectShell } from "@/modules/tracking/projects/project-shell";

export default async function ProjectLayout({ children, params }: LayoutProps<"/[workspace]/projects/[key]">) {
  const { key } = await params;
  return <ProjectShell projectKey={decodeURIComponent(key).toUpperCase()}>{children}</ProjectShell>;
}
