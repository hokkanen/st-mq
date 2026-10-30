ARG BUILD_FROM
FROM ${BUILD_FROM}
COPY run.sh /usr/local/bin/stmq-shared-broker
RUN chmod 0755 /usr/local/bin/stmq-shared-broker
ENTRYPOINT ["/usr/local/bin/stmq-shared-broker"]
