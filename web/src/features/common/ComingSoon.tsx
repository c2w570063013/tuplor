import { Hammer } from 'lucide-react';
import { EmptyState } from '@/components/ui';

export function ComingSoon({ name }: { name: string }) {
  return <EmptyState icon={<Hammer size={28} />} title={name} description="This module is being built by the team." />;
}
