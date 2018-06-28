import moment from 'moment';
import _ from 'lodash';

export interface DataTarget {
  target: string;
  datapoints: any[];
  refId: string;
  query: any;
}
export interface TableResult {
  columns: TableColumn[];
  rows: any[];
  type: string;
  refId: string;
  query: string;
}

export interface TableColumn {
  text: string;
  type: string;
}

export interface KustoSchema {
  Databases: { [key: string]: KustoDatabase };
  Plugins: any[];
}
export interface KustoDatabase {
  Name: string;
  Tables: { [key: string]: KustoTable };
  Functions: { [key: string]: KustoFunction };
}

export interface KustoTable {
  Name: string;
  OrderedColumns: KustoColumn[];
}

export interface KustoColumn {
  Name: string;
  Type: string;
}

export interface KustoFunction {
  Name: string;
  DocString: string;
  Body: string;
  Folder: string;
  FunctionKind: string;
  InputParameters: any[];
  OutputColumns: any[];
}

export interface Variable {
  text: string;
  value: string;
}

export default class ResponseParser {
  columns: Array<string>;
  constructor(private results) {}

  parseQueryResult(): any {
    let data: TableResult | DataTarget[] = [];
    let columns: any[] = [];
    for (let i = 0; i < this.results.length; i++) {
      if (this.results[i].result.data.tables.length === 0) {
        continue;
      }
      columns = this.results[i].result.data.tables[0].columns;
      const rows = this.results[i].result.data.tables[0].rows;

      if (this.results[i].query.resultFormat === 'time_series') {
        data = _.concat(data, this.parseTimeSeriesResult(this.results[i].query, columns, rows));
      } else {
        data = _.concat(data, this.parseTableResult(this.results[i].query, columns, rows));
      }
    }

    return data;
  }

  parseTimeSeriesResult(query, columns, rows): DataTarget[] {
    const data: DataTarget[] = [];
    let timeIndex = -1;
    let metricIndex = -1;
    let valueIndex = -1;

    for (let i = 0; i < columns.length; i++) {
      if (timeIndex === -1 && columns[i].type === 'datetime') {
        timeIndex = i;
      }

      if (metricIndex === -1 && columns[i].type === 'string') {
        metricIndex = i;
      }

      if (valueIndex === -1 && ['int', 'long', 'real', 'double'].includes(columns[i].type)) {
        valueIndex = i;
      }
    }

    if (timeIndex === -1) {
      throw new Error('No datetime column found in the result. The Time Series format requires a time column.');
    }

    _.forEach(rows, function(row) {
      const epoch = ResponseParser.dateTimeToEpoch(row[timeIndex]);
      const metricName = metricIndex > -1 ? row[metricIndex] : columns[valueIndex].name;
      const bucket = ResponseParser.findOrCreateBucket(data, metricName);
      bucket.datapoints.push([row[valueIndex], epoch]);
      bucket.refId = query.refId;
      bucket.query = query.query;
    });

    return data;
  }

  parseTableResult(query, columns, rows): TableResult {
    const tableResult: TableResult = {
      type: 'table',
      columns: _.map(columns, col => {
        return { text: col.name, type: col.type };
      }),
      rows: rows,
      refId: query.refId,
      query: query.query,
    };

    return tableResult;
  }

  parseToVariables(): Variable[] {
    const queryResult = this.parseQueryResult();

    const variables: Variable[] = [];
    _.forEach(queryResult, result => {
      _.forEach(_.flattenDeep(result.rows), row => {
        variables.push({
          text: row,
          value: row,
        });
      });
    });

    return variables;
  }

  parseSchemaResult(): KustoSchema {
    return {
      Plugins: [
        {
          Name: 'pivot',
        },
      ],
      Databases: this.createSchemaDatabaseWithTables(),
    };
  }

  createSchemaDatabaseWithTables(): { [key: string]: KustoDatabase } {
    const databases = {
      Default: {
        Name: 'Default',
        Tables: this.createSchemaTables(),
        Functions: this.createSchemaFunctions(),
      },
    };

    return databases;
  }

  createSchemaTables(): { [key: string]: KustoTable } {
    const tables: { [key: string]: KustoTable } = {};

    for (let key in this.results.types) {
      tables[key] = {
        Name: this.results.types[key].analytics.tableName,
        OrderedColumns: [],
      };
      _.forEach(this.results.types[key].properties, prop => {
        tables[key].OrderedColumns.push(this.findMetadataProp(prop));
      });
    }

    return tables;
  }

  findMetadataProp(propName: string): KustoColumn {
    return {
      Name: propName,
      Type: this.results.properties[propName].analytics.columnType,
    };
  }

  createSchemaFunctions(): { [key: string]: KustoFunction } {
    const functions: { [key: string]: KustoFunction } = {};

    for (let key in this.results.queries) {
      functions[this.results.queries[key].analytics.functionName] = {
        Name: this.results.queries[key].analytics.functionName,
        Body: this.results.queries[key].analytics.functionBody,
        DocString: this.results.queries[key].displayName,
        Folder: this.results.queries[key].category,
        FunctionKind: 'Unknown',
        InputParameters: [],
        OutputColumns: [],
      };
    }

    return functions;
  }

  static findOrCreateBucket(data, target): DataTarget {
    let dataTarget = _.find(data, ['target', target]);
    if (!dataTarget) {
      dataTarget = { target: target, datapoints: [], refId: '', query: '' };
      data.push(dataTarget);
    }

    return dataTarget;
  }

  static dateTimeToEpoch(dateTime) {
    return moment(dateTime).valueOf();
  }
}
