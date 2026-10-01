# Multi-stage minimal build for Meepo Go standalone proxy
FROM golang:1.24-alpine AS builder

WORKDIR /app
COPY go.mod ./
COPY cmd/ ./cmd/
COPY pkg/ ./pkg/

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/bin/meepo ./cmd/meepo

# Final runtime image: scratch or alpine
FROM alpine:3.20

RUN apk --no-cache add ca-certificates curl

WORKDIR /app
COPY --from=builder /app/bin/meepo /usr/local/bin/meepo
COPY meepo.config.json /app/meepo.config.json

EXPOSE 8081

ENV MEEPO_HOST=0.0.0.0
ENV MEEPO_PORT=8081

ENTRYPOINT ["/usr/local/bin/meepo", "serve", "--host", "0.0.0.0", "--port", "8081"]
