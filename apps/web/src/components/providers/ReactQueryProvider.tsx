"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import React from "react";

const ReactQueryProvider = ({ children }: React.PropsWithChildren) => {
  const [client] = React.useState(new QueryClient());
  const displayDevtools = false;

  return (
    <QueryClientProvider client={client}>
      {children}
      {displayDevtools && <ReactQueryDevtools initialIsOpen={false} />}
    </QueryClientProvider>
  );
};
export default ReactQueryProvider;
