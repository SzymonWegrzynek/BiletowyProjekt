import { NotFoundMessage } from "@/components/NotFoundMessage";

export default function NotFound() {
  return (
    <NotFoundMessage
      title="Nie ma takiej strony"
      description="Sprawdź adres albo wróć do repertuaru."
    />
  );
}
