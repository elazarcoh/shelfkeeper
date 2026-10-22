import { createFileRoute } from '@tanstack/react-router'
import { PageBody, PageHeader } from '@/components/page'
import { CsvImport } from '@/features/csv/csv-import'

export const Route = createFileRoute('/_app/books/import')({ component: ImportPage })

function ImportPage() {
  return (
    <PageBody width="narrow">
      <PageHeader title="Import a CSV file" description="Each row becomes a suggestion in your Inbox. Nothing is added until you accept it." />
      <CsvImport />
    </PageBody>
  )
}
