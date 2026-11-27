import { NotFoundMessage } from "@/components/NotFoundMessage";

export default function TicketNotFound() {
  return (
    <NotFoundMessage
      title="Nie ma takiego biletu"
      description="Sprawdź kod biletu albo wybierz nowy spektakl."
    />
  );
}
